/**
 * Арифметика путей дерева контента. Путь здесь — тот же идентификатор, что у
 * presentation-ассета: путь от корня дерева контента (`assets` ASSET-2,
 * `game-content` CONT-2). Отдельного «пути редактора» не заводится — второе имя
 * одного и того же документа разъехалось бы с первым при первом переименовании
 * (то же основание, по которому `DocumentId` в `document/types.ts` равен ID
 * ассета).
 *
 * Разделитель всегда `/`, ведущего слэша нет, корень — пустая строка. Причина в
 * ED-12: путь пересекает границу сред, а в вебе никакой файловой системы нет
 * вовсе — значит, форма пути обязана быть свойством дерева, а не свойством той
 * ОС, где редактор сегодня запущен.
 */

/** Путь от корня дерева контента; пустая строка — сам корень. */
export type ContentPath = string;

/**
 * Приводит путь к канонической форме и запрещает выход за корень. Выход
 * запрещён по той же границе, по которой его запрещает загрузчик ассетов
 * (ASSET-3): редактор работает в дереве контента, а не в файловой системе
 * хоста, и в вебе за корнем для него ничего и нет.
 */
export function normalizeContentPath(path: ContentPath): ContentPath {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`путь "${path}" выходит за корень дерева контента`);
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Последний сегмент пути: имя файла или каталога. Для корня — пустая строка. */
export function contentPathName(path: ContentPath): string {
  const normalized = normalizeContentPath(path);
  const at = normalized.lastIndexOf('/');
  return at < 0 ? normalized : normalized.slice(at + 1);
}

/** Каталог, в котором лежит путь. Для верхнего уровня и для корня — корень. */
export function contentPathParent(path: ContentPath): ContentPath {
  const normalized = normalizeContentPath(path);
  const at = normalized.lastIndexOf('/');
  return at < 0 ? '' : normalized.slice(0, at);
}

/** Расширение с точкой в нижнем регистре или пустая строка. Реестр загрузчиков ассетов ключуется им же (ASSET-3). */
export function contentPathExtension(path: ContentPath): string {
  const name = contentPathName(path);
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

/** Склейка сегментов с нормализацией: `join('visuals', 'models/a.mdx')`. */
export function joinContentPath(...parts: readonly ContentPath[]): ContentPath {
  return normalizeContentPath(parts.join('/'));
}

/** Лежит ли путь внутри каталога (или совпадает с ним). Корень содержит всё. */
export function isInsideContentPath(path: ContentPath, directory: ContentPath): boolean {
  const inner = normalizeContentPath(path);
  const outer = normalizeContentPath(directory);
  if (outer === '') return true;
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Порядок путей одного уровня. Задан явно и одинаков во всех средах: браузерный
 * и десктопный хосты перечисляют каталог в том порядке, в каком его отдаёт их
 * API, и без общего правила просмотрщик ассетов (ED-20) показывал бы одно и то
 * же дерево двумя разными списками — то есть паритет сред (ED-12) переставал бы
 * быть проверяемым.
 */
export function compareContentNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
