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
import { realpath as realpathNative, realpathSync } from 'node:fs';
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
 * Что файловая система ответила о пути.
 *
 * Три исхода, а не два, потому что «пути нет» и «разрешить не удалось» — разные
 * ответы, и путать их здесь опаснее всего: у первого есть законное продолжение
 * (недостающее создаст запись), у второго — нет никакого.
 */
type Real =
  | { readonly kind: 'path'; readonly path: string }
  /** Пути ещё нет — `ENOENT` (на POSIX ещё `ENOTDIR`, когда предок оказался файлом). */
  | { readonly kind: 'missing' }
  /** Разрешить не удалось по иной причине: это отказ, а не «ещё нет». */
  | { readonly kind: 'failed'; readonly why: string };

function classify(error: unknown): Real {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
  return { kind: 'failed', why: error instanceof Error ? error.message : String(error) };
}

/**
 * Разрешается ли цель внутрь корня НА САМОМ ДЕЛЕ. `null` — да; строка — причина
 * отказа, которую и увидит вызывающий.
 *
 * Решает первый предок, который СУЩЕСТВУЕТ: то, чего ещё нет, окажется там, куда
 * указывает он. Не разрешается даже сам корень — корня ещё нет на диске, и
 * ссылке, ведущей наружу, взяться неоткуда: недостающие каталоги создаст сама
 * запись.
 *
 * А вот предок, который есть, но не разрешается, — отказ, и это не педантизм.
 * Системный `realpath` умеет отказывать не только «нет такого пути»: на musl он
 * требует смонтированного `/proc`, на Windows отвечает `UNKNOWN` на точке
 * подключения, чей том не подключён. Проглотить такой ответ значило бы молча
 * опустить проверку до лексической — ровно до той, недостаточность которой и
 * описана в шапке модуля.
 */
async function outsideReason(absolute: string, directory: string, real: string): Promise<string | null> {
  const chain = chainToRoot(absolute, directory);
  if (chain.length === 0) return OUTSIDE;
  for (const probe of chain) {
    const found = await realOf(probe);
    if (found.kind === 'failed') return unresolved(found.why);
    if (found.kind === 'path') return contains(real, found.path) ? null : OUTSIDE;
  }
  return null;
}

/** Синхронный близнец `outsideReason` — для `resolve`, который синхронен. */
function outsideReasonSync(absolute: string, directory: string, real: string): string | null {
  const chain = chainToRoot(absolute, directory);
  if (chain.length === 0) return OUTSIDE;
  for (const probe of chain) {
    const found = realSync(probe);
    if (found.kind === 'failed') return unresolved(found.why);
    if (found.kind === 'path') return contains(real, found.path) ? null : OUTSIDE;
  }
  return null;
}

const OUTSIDE = 'разрешается за пределы корня (DSK-5)';
const unresolved = (why: string): string =>
  `не разрешается файловой системой, и границу по нему не проверить: ${why} (DSK-5)`;

/**
 * Реальный путь пути на диске.
 *
 * Разрешает ОБЕ пары — синхронная и асинхронная — одна и та же реализация
 * `realpath`, системная (`native`). Это не вкусовщина: у Node две разные
 * реализации, и они отвечают РАЗНОЕ. Своя, на `lstat`, разворачивает ссылки, но
 * оставляет путь таким, как его написали; системная приводит путь к
 * каноническому виду целиком — на Windows это, в частности, разворачивает
 * короткие имена 8.3 (`C:\Users\3EC2~1\…` → `C:\Users\Антон\…`).
 *
 * Взять на две стороны разные реализации значит сравнивать разные написания
 * одного каталога. Ровно это и случилось: корень запоминался своей, цель
 * разрешалась системной, `contains` не совпадал ни разу — и корень, лежащий под
 * коротким путём, отвергал КАЖДУЮ операцию как выход за свои пределы (DSK-5),
 * не выпустив при этом наружу ничего. Отказ ложный, а выглядит как настоящий.
 */
function realSync(path: string): Real {
  try {
    return { kind: 'path', path: realpathSync.native(path) };
  } catch (error) {
    return classify(error);
  }
}

/** Асинхронный близнец `realSync` — та же системная реализация. */
function realOf(path: string): Promise<Real> {
  return new Promise((done) => {
    realpathNative.native(path, (error, resolved) => {
      done(error === null ? { kind: 'path', path: resolved } : classify(error));
    });
  });
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
   *
   * Корень, который ЕСТЬ, но не разрешается, — отказ, а не повод сверяться с
   * лексическим путём: сверка двух разных написаний одного каталога не значит
   * ничего, а выглядит как пройденная проверка.
   */
  let realDirectory: string | null = null;
  const rootReal = (): string => {
    if (realDirectory !== null) return realDirectory;
    const found = realSync(directory);
    if (found.kind === 'failed') throw refuse(id, directory, `корень ${unresolved(found.why)}`);
    // Корня ещё нет на диске — сверяться не с чем, и это законно: цель тогда
    // тоже не разрешается ни в одном предке, а недостающее создаст запись.
    if (found.kind === 'missing') return directory;
    realDirectory = found.path;
    return realDirectory;
  };

  const absoluteOf = (path: string): string => resolve(join(directory, normalizeHostPath(path)));

  const at = async (path: string): Promise<string> => {
    const absolute = absoluteOf(path);
    const why = await outsideReason(absolute, directory, rootReal());
    if (why !== null) throw refuse(id, path, why);
    return absolute;
  };

  const atSync = (path: string): string => {
    const absolute = absoluteOf(path);
    const why = outsideReasonSync(absolute, directory, rootReal());
    if (why !== null) throw refuse(id, path, why);
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
 * путём дерева (DSK-5). Пути ещё нет — сверяется лексически: диалог отдаёт
 * существующий путь, а несуществующему взяться из ссылки неоткуда. Не
 * РАЗРЕШАЕТСЯ (иная ошибка файловой системы) — ответ «вне корня»: это отказ в
 * сторону строгости, а сверять непроверенное значило бы отвечать наугад.
 */
export function insideRoot(root: HostRoot, absolute: string): HostPath | null {
  const target = realSync(resolve(absolute));
  const rootPath = realSync(root.directory);
  if (target.kind === 'failed' || rootPath.kind === 'failed') return null;
  const full = target.kind === 'path' ? target.path : resolve(absolute);
  const base = rootPath.kind === 'path' ? rootPath.path : root.directory;
  if (full === base) return '';
  if (!contains(base, full)) return null;
  return relative(base, full).split(sep).join('/');
}
