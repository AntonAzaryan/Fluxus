/**
 * ED-25, третий абзац: «Каркас <…> MUST NOT содержать доменных имён
 * редактируемого («террейн», «префаб», «система», «манифест»)». Требование
 * механическое, поэтому и проверка механическая: сканер по исходникам пакета, а
 * не дисциплина автора — доменное ветвление приезжает не намерением, а правкой
 * «на минуту», которую никто не перечитывает.
 *
 * Форма проверки — денилист по `src/**` пакета headless-каркаса:
 *
 * - Комментарии вырезаются: сам текст ED-25 цитирует запрещённые слова, и
 *   объяснить «почему» без них нельзя. Ветвиться по домену комментарий не умеет.
 * - Скан идёт по идентификаторам и по содержимому строковых литералов:
 *   `if (type === 'terrain')` — ровно тот дефект, который требование называет.
 * - Идентификаторы разбиваются по camelCase и сводятся к единственному числу,
 *   поэтому `terrainBrush` и `systems` ловятся, а `filesystem` — нет.
 * - Файл, объявивший себя вкладом маркером `@contribution` в шапке, исключён:
 *   вклад и есть место доменного знания. Маркер греп-видим, и его появление —
 *   такая же правка на ревью, как и правка самого каркаса. Маркер, а не список
 *   путей, потому что вклады добавляются, а центральный список правился бы на
 *   каждый вклад — то самое «расширение правит каркас», которое запрещает ED-25.
 *
 * Чего проверка не ловит (сказано здесь, чтобы её не считали доказательством):
 * доменное знание, выраженное без доменных слов (`kind === 'a'`), собранный из
 * кусков литерал, синонимы и транслитерации, а также доменные имена, попадающие
 * в каркас данными вклада, — последнее и не дефект.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Четыре слова названы в ED-25 буквально; остальные — тот же материал, чьё
 * появление в каркасе означает ту же ошибку.
 */
const DOMAIN_WORDS = [
  'terrain',
  'prefab',
  'manifest',
  'system',
  'scene',
  'component',
  'brush',
  'texture',
];

/**
 * Исключений по пути нет. Слой ресурсов ED-25 называет каркасом прямо, и
 * закрытый список видов описываемого внутри него (`component`, `prefab`,
 * `system`, …) был бы ровно запрещённым случаем: новый вид редактируемого
 * правил бы каркас. Список снят — вид приносит тот, кто приносит путь, а отчёт
 * ED-28 берёт множество видов из поданных ему путей. Доменные имена остались
 * только в источнике путей, помеченном `@contribution`.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {};

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(`${path}/`));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

/** Блочные и строчные комментарии. `[^:]` бережёт `https://` от вырезания. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function domainWordsIn(source: string): string[] {
  const words = new Set<string>();
  for (const [token] of stripComments(source).matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    for (const part of token.split(/(?=[A-Z])/)) {
      const word = part.toLowerCase().replace(/s$/, '');
      if (DOMAIN_WORDS.includes(word)) words.add(word);
    }
  }
  return [...words].sort();
}

describe('ED-25: каркас без доменных имён редактируемого', () => {
  const files = sourceFiles(SRC);

  it('в пакете есть что сканировать', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('ни один файл каркаса не называет редактируемое по имени', () => {
    const violations: Record<string, string[]> = {};
    for (const file of files) {
      const relative = file.slice(SRC.length);
      if (Object.keys(EXCEPTIONS).some((excluded) => relative.startsWith(excluded))) continue;
      const source = readFileSync(file, 'utf8');
      if (source.includes('@contribution')) continue;
      const found = domainWordsIn(source);
      if (found.length > 0) violations[relative] = found;
    }
    expect(violations).toEqual({});
  });

  it('сканер видит доменное ветвление', () => {
    // Контроль самого сканера: без него зелёный тест не отличим от сканера,
    // который ничего не ищет.
    expect(domainWordsIn("if (document.type === 'terrain') return terrainEditor;")).toEqual([
      'terrain',
    ]);
    expect(domainWordsIn('const prefabTools = [];')).toEqual(['prefab']);
    expect(domainWordsIn('// про террейн и prefab здесь только в комментарии')).toEqual([]);
    expect(domainWordsIn('const filesystemPath = "";')).toEqual([]);
  });
});
