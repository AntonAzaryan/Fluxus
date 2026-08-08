/**
 * Рекурсивный обход дерева контента — то, на чём стоит просмотрщик ассетов
 * (ED-20: навигация по дереву контента). В шов хоста он не входит намеренно:
 * обход собирается из `list`, одинаков в обеих средах и потому средой не
 * различается — а в шов ED-12 просит вынести только различия.
 *
 * Порядок обхода нормирован: каталог перед своим содержимым, внутри уровня — по
 * имени (`compareContentNames`). Два хоста, отдающие одно дерево, обязаны дать
 * один список; иначе просмотрщик в вебе и на десктопе показывал бы одно и то же
 * дерево по-разному, и паритет сред перестал бы быть проверяемым.
 */
import { compareContentNames, normalizeContentPath } from './paths.js';
import type { ContentPath } from './paths.js';
import type { ContentEntry, ContentTreeHost } from './types.js';

/**
 * Предел глубины по умолчанию. Он существует не ради экономии: на десктопе в
 * дереве может оказаться символическая ссылка на предка, и обход без предела
 * не вернулся бы никогда — просмотрщик ассетов повис бы на открытии проекта.
 * В вебе такой ссылки не бывает, но предел общий: различие сред не должно
 * менять поведение кода вне шва (ED-12).
 */
export const DEFAULT_WALK_DEPTH = 16;

export interface WalkOptions {
  readonly maxDepth?: number;
  /** Не заходить внутрь каталога (служебные каталоги инструментов, `node_modules`). */
  readonly skipDirectory?: (entry: ContentEntry) => boolean;
  /** Оставить в результате только подходящие файлы; каталоги фильтр не отсеивает. */
  readonly acceptFile?: (entry: ContentEntry) => boolean;
}

/**
 * Плоский список содержимого поддерева. Каталоги входят в результат: ED-20
 * требует навигации, а не только перечня файлов, и дерево без узлов
 * навигацией не является.
 */
export async function walkContentTree(
  host: ContentTreeHost,
  root: ContentPath = '',
  options: WalkOptions = {},
): Promise<readonly ContentEntry[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_WALK_DEPTH;
  const out: ContentEntry[] = [];
  await descend(host, normalizeContentPath(root), 0, maxDepth, options, out);
  return out;
}

async function descend(
  host: ContentTreeHost,
  at: ContentPath,
  depth: number,
  maxDepth: number,
  options: WalkOptions,
  out: ContentEntry[],
): Promise<void> {
  if (depth >= maxDepth) return;
  const entries = [...(await host.list(at))].sort((a, b) => compareContentNames(a.name, b.name));
  for (const entry of entries) {
    if (entry.kind === 'file') {
      if (options.acceptFile === undefined || options.acceptFile(entry)) out.push(entry);
      continue;
    }
    if (options.skipDirectory?.(entry) === true) continue;
    out.push(entry);
    await descend(host, entry.path, depth + 1, maxDepth, options, out);
  }
}
