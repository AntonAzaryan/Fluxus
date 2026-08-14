/**
 * Объявленный профилем корень на диске: чтение, запись, перечисление,
 * наблюдение (DSK-2, DSK-4).
 *
 * ## Границу держит корень, а не вызывающий
 *
 * Каждый путь проходит `normalizeHostPath` и, сверх того, сверяется по
 * абсолютному пути с каталогом корня. Две проверки, а не одна, потому что они
 * ловят разное: первая — путь, написанный вызывающим (`../../etc/passwd`),
 * вторая — всё, что добавит сама файловая система при разрешении. Тот же приём
 * стоит в эндпойнте дерева у веб-среды редактора (`resolveInside`), и
 * повторяется он здесь не по инерции: у контейнера это единственная дверь между
 * страницей и диском (DSK-5).
 *
 * ## Запись атомарна
 *
 * Байты уходят во временный файл рядом с целью и переименовываются на место —
 * тот же приём, что у импортёра конвейера (BLND-6). Причина та же: сорвавшаяся
 * посреди записи операция обязана оставить прежний файл целым, а не половину
 * нового. Наблюдатель при этом видит переименование, а не поток дописываний, —
 * одно событие на одну запись.
 *
 * Временные файлы корень отличает по имени и в событиях наблюдения не
 * показывает: собственный технический артефакт — не изменение дерева.
 *
 * ## Вид изменения
 *
 * `fs.watch` вида изменения не сообщает — только имя. Корень восстанавливает
 * его по состоянию файла: файла нет — `removed`, файл есть и раньше о нём не
 * знали — `created`, иначе `modified`. Отсюда честная неточность, названная
 * прямо: первое событие о файле, существовавшем ещё до подписки, придёт как
 * `created`. Потребителю обе формы означают «перечитай», и строить ради
 * различения индекс всего дерева на старте — платить деревом за уведомление.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
  BridgeChange,
  BridgeChangeKind,
  BridgeChangeListener,
  BridgeEntry,
  BridgeRootId,
  BridgeUnsubscribe,
} from '../bridge/types.js';
import { NODE_OBSERVER, type DirectoryObserver } from './observe.js';
import { compareHostNames, hostPathName, normalizeHostPath, type HostPath } from './paths.js';

export interface HostRootOptions {
  readonly id: BridgeRootId;
  readonly label?: string;
  /** Абсолютный путь каталога корня. */
  readonly directory: string;
  readonly writable?: boolean;
  readonly serve?: boolean;
  /** Наблюдатель; по умолчанию — `fs.watch`. Тест подставляет свой. */
  readonly observer?: DirectoryObserver;
  readonly report?: (text: string) => void;
}

export interface HostRoot {
  readonly id: BridgeRootId;
  readonly label: string;
  readonly directory: string;
  readonly writable: boolean;
  readonly serve: boolean;
  /** Ведётся ли наблюдение на самом деле; до первой подписки — `false`. */
  readonly observing: boolean;
  /** Абсолютный путь; отказ, если путь выходит за корень. */
  resolve(path: string): string;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  stat(path: string): Promise<BridgeEntry | undefined>;
  list(path: string): Promise<readonly BridgeEntry[]>;
  watch(listener: BridgeChangeListener): BridgeUnsubscribe;
  close(): void;
}

/** Суффикс временного файла записи: по нему корень узнаёт собственный артефакт. */
const TEMPORARY_MARK = '.fluxus-tmp-';

let writeCounter = 0;

function refuse(root: BridgeRootId, path: string, why: string): Error {
  return new Error(`корень "${root}": "${path}" — ${why}`);
}

export function createHostRoot(options: HostRootOptions): HostRoot {
  const directory = resolve(options.directory);
  const id = options.id;
  const writable = options.writable ?? false;
  const observe = options.observer ?? NODE_OBSERVER;
  const listeners = new Set<BridgeChangeListener>();
  const known = new Set<HostPath>();
  let observation: { active: boolean; close(): void } | null = null;

  const at = (path: string): string => {
    const normalized = normalizeHostPath(path);
    const absolute = resolve(join(directory, normalized));
    if (absolute !== directory && !absolute.startsWith(directory + sep)) {
      throw refuse(id, path, 'разрешается за пределы корня (DSK-5)');
    }
    return absolute;
  };

  const notify = (change: BridgeChange): void => {
    for (const listener of [...listeners]) listener(change);
  };

  /** Событие наблюдателя → изменение дерева. `null` от платформы игнорируется. */
  const onChanged = (raw: string | null): void => {
    if (raw === null) return;
    const path = raw.split(sep).join('/');
    if (path.includes(TEMPORARY_MARK)) return;
    let normalized: HostPath;
    try {
      normalized = normalizeHostPath(path);
    } catch {
      return;
    }
    if (normalized === '') return;
    void stat(join(directory, normalized)).then(
      () => {
        const kind: BridgeChangeKind = known.has(normalized) ? 'modified' : 'created';
        known.add(normalized);
        notify({ root: id, path: normalized, kind });
      },
      () => {
        known.delete(normalized);
        notify({ root: id, path: normalized, kind: 'removed' });
      },
    );
  };

  const entryOf = (path: HostPath, isDirectory: boolean): BridgeEntry => ({
    path,
    name: hostPathName(path),
    kind: isDirectory ? 'directory' : 'file',
  });

  return {
    id,
    label: options.label ?? id,
    directory,
    writable,
    serve: options.serve ?? false,
    get observing(): boolean {
      return observation?.active ?? false;
    },

    resolve: at,

    async read(path) {
      const absolute = at(path);
      let bytes;
      try {
        bytes = await readFile(absolute);
      } catch (error) {
        throw refuse(id, path, `не прочитан: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Копия в собственный буфер: `readFile` отдаёт Buffer поверх общего пула,
      // и отдать наружу его память значило бы отдать чужие байты рядом.
      return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    },

    async write(path, bytes) {
      if (!writable) throw refuse(id, path, 'корень объявлен только на чтение (DSK-5)');
      const normalized = normalizeHostPath(path);
      if (normalized === '') throw refuse(id, path, 'запись в сам корень бессмысленна');
      const absolute = at(normalized);
      const temporary = `${absolute}${TEMPORARY_MARK}${process.pid}-${writeCounter++}`;
      await mkdir(dirname(absolute), { recursive: true });
      const existed = await stat(absolute).then(
        () => true,
        () => false,
      );
      try {
        await writeFile(temporary, bytes);
        await rename(temporary, absolute);
      } catch (error) {
        await rm(temporary, { force: true });
        throw refuse(id, path, `не записан: ${error instanceof Error ? error.message : String(error)}`);
      }
      // О собственной записи наблюдатели узнают сразу и от самого корня:
      // событие файловой системы придёт позже, а то и не придёт вовсе — там,
      // где наблюдения нет. Повтор от наблюдателя безвреден: обе формы значат
      // «перечитай».
      known.add(normalized);
      notify({ root: id, path: normalized, kind: existed ? 'modified' : 'created' });
    },

    async stat(path) {
      const normalized = normalizeHostPath(path);
      try {
        const found = await stat(at(normalized));
        return entryOf(normalized, found.isDirectory());
      } catch {
        return undefined;
      }
    },

    async list(path) {
      const normalized = normalizeHostPath(path);
      let entries;
      try {
        entries = await readdir(at(normalized), { withFileTypes: true });
      } catch {
        // Каталога нет — пустой список: перечисление одинаково во всех
        // реализациях контейнера, и «нет каталога» — обычный ответ о дереве.
        return [];
      }
      const out = entries
        .filter((entry) => !entry.name.includes(TEMPORARY_MARK))
        .map((entry) =>
          entryOf(normalized === '' ? entry.name : `${normalized}/${entry.name}`, entry.isDirectory()),
        );
      return out.sort((a, b) => compareHostNames(a.name, b.name));
    },

    watch(listener) {
      listeners.add(listener);
      observation ??= observe({ directory, changed: onChanged, ...(options.report === undefined ? {} : { report: options.report }) });
      return () => {
        listeners.delete(listener);
      };
    },

    close() {
      listeners.clear();
      observation?.close();
      observation = null;
    },
  };
}

/** Путь файла относительно корня или `null` — файл лежит вне его. */
export function insideRoot(root: HostRoot, absolute: string): HostPath | null {
  const full = resolve(absolute);
  if (full === root.directory) return '';
  if (!full.startsWith(root.directory + sep)) return null;
  return relative(root.directory, full).split(sep).join('/');
}
