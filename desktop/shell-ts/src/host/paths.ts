/**
 * Арифметика путей внутри объявленного корня.
 *
 * Такая же арифметика есть у шва среды редактора (`editor/core-ts`,
 * `host/paths.ts`), и импортировать её отсюда нельзя: контейнер не зависит от
 * пакетов редактора и движка (DSK-3). Повтор здесь — не недосмотр, а цена
 * границы, и цена честная: правило пути («разделитель `/`, ведущего слэша нет,
 * за корень не выходим») принадлежит не редактору — оно свойство любого дерева,
 * которое раздают по путям, и совпадение форм у двух слоёв — то, что делает
 * адаптер на стороне приложения тривиальным.
 *
 * Выход за корень — отказ, а не усечение: путь `../secret` обязан краснеть, а
 * не превращаться в `secret`. Единственная дверь наружу у контейнера — корень
 * профиля (DSK-5), и молчаливая нормализация была бы обходом этой двери.
 */

/** Путь внутри корня; пустая строка — сам корень. */
export type HostPath = string;

/**
 * Каноническая форма пути. Бросает, если путь выходит за корень или содержит
 * то, чего в пути дерева не бывает (`NUL`, абсолютный путь Windows).
 */
export function normalizeHostPath(path: string): HostPath {
  if (path.includes('\0')) throw new Error(`путь "${path}" содержит NUL`);
  if (/^[a-zA-Z]:/.test(path)) throw new Error(`путь "${path}" абсолютен: корень задаёт профиль`);
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      throw new Error(`путь "${path}" выходит за корень (DSK-5)`);
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Последний сегмент пути: имя файла или каталога. Для корня — пустая строка. */
export function hostPathName(path: HostPath): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/** Расширение с точкой в нижнем регистре либо пустая строка. */
export function hostPathExtension(path: HostPath): string {
  const name = hostPathName(path);
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

/** Склейка сегментов с нормализацией. */
export function joinHostPath(...parts: readonly string[]): HostPath {
  return normalizeHostPath(parts.join('/'));
}

/**
 * Порядок имён одного уровня. Задан явно и одинаков во всех реализациях
 * контейнера: порядок, в котором каталог отдаёт ОС, свойством дерева не
 * является, а перечисление — часть контракта (DSK-2).
 */
export function compareHostNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
