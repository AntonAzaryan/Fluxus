/**
 * Подпорки тестов контейнера: временное дерево на диске и подставной
 * наблюдатель.
 *
 * Наблюдатель подставной по той же причине, по которой он инжектируется в
 * коде (`src/host/observe.ts`): семантика событий — поведение кода, а тайминги
 * `fs.watch` — поведение ядра ОС. Живой наблюдатель проверяется ровно одним
 * тестом (`watchLive.test.ts`), и там ожидание — по условию с крайним сроком, а
 * не по часам.
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DirectoryObserver, DirectoryObserverOptions } from '../src/host/observe.js';

/** Временный каталог с записанными файлами; ключ — путь от его корня. */
export async function makeTree(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fluxus-shell-'));
  for (const [path, content] of Object.entries(files)) await putFile(root, path, content);
  return root;
}

export async function putFile(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function readText(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch {
    return undefined;
  }
}

/** Содержимое файла, которого странице видеть не положено. */
export const OUTSIDE_SECRET = 'СЕКРЕТ ВНЕ КОРНЯ';

/**
 * Кладёт по `path` внутри дерева ссылку на каталог `outside` (вне дерева), где
 * лежит `secret.txt`. Так дерево контента приезжает от чужого инструмента —
 * страница ссылок не создаёт (DSK-5).
 */
export async function linkOutside(root: string, path: string, outside: string): Promise<void> {
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'secret.txt'), OUTSIDE_SECRET);
  await symlink(outside, join(root, path), 'dir');
}

export async function dropTree(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export interface FakeObserver {
  readonly observer: DirectoryObserver;
  /** Сколько наблюдений открыто прямо сейчас. */
  readonly open: number;
  /** Сообщить об изменении так, как это сделал бы `fs.watch`. */
  emit(relative: string | null): void;
}

export function fakeObserver(): FakeObserver {
  const opened: DirectoryObserverOptions[] = [];
  let live = 0;
  return {
    observer: (options) => {
      opened.push(options);
      live += 1;
      return {
        active: true,
        close: () => {
          live -= 1;
        },
      };
    },
    get open(): number {
      return live;
    },
    emit(relative) {
      for (const options of opened) options.changed(relative);
    },
  };
}

/** Ждёт условия до крайнего срока: медленная машина делает тест медленнее, а не красным. */
export async function waitFor(condition: () => boolean, deadlineMs = 4000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((done) => setTimeout(done, 10));
  }
  return condition();
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
