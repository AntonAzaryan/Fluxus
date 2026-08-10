/**
 * Хост среды поверх файловой системы Node (ED-12) — среда командной строки.
 *
 * Реализаций хоста было две: веб (`@game-mvp/editor-ui`) и хост в памяти
 * (`createMemoryHost`, тестовый дубль и подложка несохранённого). Командная
 * строка — третья среда, и своей реализации она требует ровно потому, что
 * ED-12 запрещает обратное: код импорта обращаться к файловой системе напрямую
 * не вправе, а веб-хост в Node не поднимается. Различие сред кончается здесь —
 * операция импорта, валидация и сохранение об этом файле не знают (BLND-5).
 *
 * Чего у этой среды нет, она говорит честно, а не изображает (ED-12, ED-20):
 * диалогов выбора нет — `undefined`; окна нет — заголовок и признак
 * несохранённого никуда не идут; наблюдения за деревом нет — `watch` отдаёт
 * отписку и молчит (watch-режим конвейера — BLND-12, задача 9.1, и живёт он в
 * CLI, а не в шве).
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  compareContentNames,
  contentPathName,
  normalizeContentPath,
  type ContentEntry,
  type ContentPath,
  type ContentRootInfo,
  type ContentTreeHost,
  type EnvironmentHost,
} from '@game-mvp/editor-core';

export interface NodeHostOptions {
  /** Абсолютный путь корня дерева контента (CONT-1): все пути отсчитываются от него. */
  readonly root: string;
  readonly name?: string;
  /** Показываемое имя корня; по умолчанию — сам путь. */
  readonly label?: string;
}

export interface NodeHost extends EnvironmentHost {
  /** Абсолютный путь корня — нужен диагностике и сообщениям, а не логике. */
  readonly directory: string;
}

/**
 * Абсолютный путь файла дерева. Нормализация пути (`normalizeContentPath`) не
 * пускает за корень — та же граница, что у загрузчика ассетов (ASSET-3): в вебе
 * за корнем для редактора ничего и нет, и в Node этой разницы быть не должно.
 */
function absolute(root: string, path: ContentPath): string {
  return join(root, normalizeContentPath(path));
}

export function createNodeHost(options: NodeHostOptions): NodeHost {
  const root = resolve(options.root);
  const info: ContentRootInfo = { label: options.label ?? root };

  const content: ContentTreeHost = {
    async read(path) {
      const bytes = await readFile(absolute(root, path));
      // Копия в собственный буфер: `readFile` отдаёт Buffer поверх общего пула,
      // и отдать наружу его `ArrayBuffer` значило бы отдать чужие байты рядом.
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async write(path, bytes) {
      const target = absolute(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    async stat(path) {
      const normalized = normalizeContentPath(path);
      try {
        const found = await stat(absolute(root, normalized));
        return {
          path: normalized,
          name: contentPathName(normalized),
          kind: found.isDirectory() ? 'directory' : 'file',
        };
      } catch {
        return undefined;
      }
    },
    async list(path) {
      const normalized = normalizeContentPath(path);
      let entries;
      try {
        entries = await readdir(absolute(root, normalized), { withFileTypes: true });
      } catch {
        return [];
      }
      const out: ContentEntry[] = entries.map((entry) => {
        const child = normalized === '' ? entry.name : `${normalized}/${entry.name}`;
        return { path: child, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' };
      });
      // Порядок нормирован швом и одинаков во всех средах (`host/paths.ts`):
      // порядок, в котором каталог отдаёт ОС, свойством дерева не является.
      return out.sort((a, b) => compareContentNames(a.name, b.name));
    },
    watch() {
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- baseline
      return () => {};
    },
  };

  return {
    name: options.name ?? 'node',
    root: info,
    directory: root,
    content,
    picker: {
      // Диалогов выбора у командной строки нет: отказ пользователя и отсутствие
      // диалога у среды выражаются одинаково — `undefined` (ED-12).
      chooseRoot: () => Promise.resolve(undefined),
      chooseFile: () => Promise.resolve(undefined),
      chooseDirectory: () => Promise.resolve(undefined),
    },
    window: {
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- baseline
      setTitle: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- baseline
      setUnsaved: () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- baseline
      onCloseRequest: () => () => {},
    },
  };
}
