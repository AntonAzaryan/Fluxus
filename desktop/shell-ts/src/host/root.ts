/**
 * Объявленный профилем корень на диске: чтение, запись, перечисление,
 * наблюдение (DSK-2, DSK-4).
 *
 * ## Границу держит корень, а не вызывающий
 *
 * Каждый путь проходит две проверки, и они ловят разное. `normalizeHostPath` —
 * про то, что написал вызывающий: `../../etc/passwd`, NUL, абсолютный путь
 * Windows. Вторая — про то, что скажет файловая система: цель разрешается
 * `realpath`'ом и сверяется с РЕАЛЬНЫМ путём каталога корня.
 *
 * Одной лексики мало, и это не теория: `path.resolve` диска не касается вовсе,
 * поэтому symlink, лежащий внутри дерева, увёл бы чтение, запись, перечисление
 * и раздачу наружу, не написав в пути ни одной точки. Создать ссылку страница
 * не может — но дерево контента приезжает и не от неё (дистрибутив, чужой
 * инструмент, репозиторий), а DSK-5 требует недостижимости «ни вызовом, ни
 * обходным путём». Ссылка в дереве — ровно обходной путь.
 *
 * У цели, которой ещё нет (запись нового документа), реален только ближайший
 * существующий предок — по нему и проверяется: то, чего нет, окажется ровно
 * там, куда указывает он. Проверка идёт ДО `mkdir`: создать каталог сквозь
 * ссылку значит уже выйти за корень.
 *
 * ## Запись атомарна
 *
 * Байты уходят во временный файл рядом с целью и переименовываются на место.
 * Гарантия та же, что импортёр конвейера даёт на уровне операции (BLND-6),
 * только здесь она файловая: сорвавшаяся посреди записи операция обязана
 * оставить прежний файл целым, а не половину нового. Наблюдатель при этом видит переименование, а не поток дописываний, —
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
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
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

/** Лежит ли путь внутри каталога. Оба пути — реальные либо оба лексические. */
function contains(directory: string, full: string): boolean {
  return full === directory || full.startsWith(directory + sep);
}

/**
 * Цепочка «цель → … → корень»: по ней ищется ближайший предок, который
 * файловая система разрешает. Выше корня цепочка не идёт — там начинается чужое
 * дерево, и подниматься туда незачем; пустая цепочка означает, что путь не
 * лежит внутри корня даже лексически.
 */
function chainToRoot(absolute: string, directory: string): string[] {
  const chain: string[] = [];
  let probe = absolute;
  while (contains(directory, probe)) {
    chain.push(probe);
    if (probe === directory) break;
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return chain;
}

/**
 * Разрешается ли цель внутрь корня НА САМОМ ДЕЛЕ. Решает первый предок, который
 * существует: то, чего ещё нет, окажется там, куда указывает он. Не разрешается
 * даже сам корень — корня ещё нет на диске, и ссылке, ведущей наружу, взяться
 * неоткуда: недостающие каталоги создаст сама запись.
 */
async function realInside(absolute: string, directory: string, real: string): Promise<boolean> {
  const chain = chainToRoot(absolute, directory);
  if (chain.length === 0) return false;
  for (const probe of chain) {
    const resolved = await realpath(probe).then(
      (value) => value,
      () => null,
    );
    if (resolved !== null) return contains(real, resolved);
  }
  return true;
}

/** Синхронный близнец `realInside` — для `resolve`, который синхронен. */
function realInsideSync(absolute: string, directory: string, real: string): boolean {
  const chain = chainToRoot(absolute, directory);
  if (chain.length === 0) return false;
  for (const probe of chain) {
    const resolved = realOrNull(probe);
    if (resolved !== null) return contains(real, resolved);
  }
  return true;
}

/** Реальный путь или `null` — пути на диске нет (или он не разрешается). */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function createHostRoot(options: HostRootOptions): HostRoot {
  const directory = resolve(options.directory);
  const id = options.id;
  const writable = options.writable ?? false;
  const observe = options.observer ?? NODE_OBSERVER;
  const listeners = new Set<BridgeChangeListener>();
  const known = new Set<HostPath>();
  let observation: { active: boolean; close(): void } | null = null;

  /**
   * Реальный путь каталога корня: считается лениво и запоминается. Лениво —
   * потому что корня может ещё не быть на диске; запоминается — потому что
   * дальше он сверяется на каждой операции. Сравнивать реальный путь цели с
   * лексическим путём корня нельзя: `/var` → `/private/var` и прочие системные
   * ссылки покраснели бы на пустом месте.
   */
  let realDirectory: string | null = null;
  const rootReal = (): string => {
    realDirectory ??= realOrNull(directory);
    return realDirectory ?? directory;
  };

  const absoluteOf = (path: string): string => resolve(join(directory, normalizeHostPath(path)));

  const at = async (path: string): Promise<string> => {
    const absolute = absoluteOf(path);
    if (!(await realInside(absolute, directory, rootReal()))) {
      throw refuse(id, path, 'разрешается за пределы корня (DSK-5)');
    }
    return absolute;
  };

  const atSync = (path: string): string => {
    const absolute = absoluteOf(path);
    if (!realInsideSync(absolute, directory, rootReal())) {
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

    resolve: atSync,

    async read(path) {
      const absolute = await at(path);
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
      // Проверка до `mkdir`: недостающие каталоги создаются ниже, и создать их
      // сквозь ссылку наружу значило бы выйти за корень раньше первой записи.
      const absolute = await at(normalized);
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
      // Отказ границы — отдельно от «такого файла нет»: первое отвергает
      // промис, второе отвечает `undefined`. Проглоти́ть первое значило бы
      // сказать «нет такого» о файле, который есть, но лежит вне корня.
      const absolute = await at(normalized);
      try {
        const found = await stat(absolute);
        return entryOf(normalized, found.isDirectory());
      } catch {
        return undefined;
      }
    },

    async list(path) {
      const normalized = normalizeHostPath(path);
      const absolute = await at(normalized);
      let entries;
      try {
        entries = await readdir(absolute, { withFileTypes: true });
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

/**
 * Путь файла относительно корня или `null` — файл лежит вне его.
 *
 * Сверяются РЕАЛЬНЫЕ пути обеих сторон: сюда приходит то, что выбрал автор в
 * системном диалоге, и ссылка, ведущая наружу, обязана стать отказом, а не
 * путём дерева (DSK-5). Не разрешается — сверяется лексически: это отказ в
 * сторону строгости, а диалог отдаёт существующий путь.
 */
export function insideRoot(root: HostRoot, absolute: string): HostPath | null {
  const full = realOrNull(resolve(absolute)) ?? resolve(absolute);
  const base = realOrNull(root.directory) ?? root.directory;
  if (full === base) return '';
  if (!contains(base, full)) return null;
  return relative(base, full).split(sep).join('/');
}
