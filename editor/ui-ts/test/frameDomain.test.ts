/**
 * ED-25, третий абзац: «Каркас — переключение областей, скелет области,
 * палитра команд, история операций, слой ресурсов — MUST NOT содержать
 * доменных имён редактируемого («террейн», «префаб», «система», «манифест»)».
 *
 * У headless-каркаса такой сканер уже есть (`editor/core-ts`,
 * `test/registryFrame.test.ts`), и он нужен здесь отдельно, а не «покрыт тем»:
 * доменное ветвление в интерфейсе приезжает своим путём — иконкой «для
 * террейна», ветвлением зоны «если это префаб», классом `.fx-scene-panel`, — и
 * пакета `core-ts` этим путём не касается.
 *
 * Форма проверки повторяет соседнюю намеренно: два разных сканера на одно
 * требование расходились бы в том, что считают доменным именем.
 *
 * - Комментарии вырезаются: сам текст ED-25 цитирует запрещённые слова.
 * - Скан идёт по идентификаторам и содержимому строковых литералов.
 * - Идентификаторы разбиваются по camelCase и сводятся к единственному числу.
 * - Файл, объявивший себя вкладом маркером `@contribution` в шапке, исключён:
 *   вклад и есть место доменного знания, и рабочие области пакета — вклады.
 *
 * Чего проверка не ловит: доменное знание, выраженное без доменных слов,
 * собранный из кусков литерал, синонимы и транслитерации, а также доменные
 * имена, приходящие в каркас данными вклада, — последнее и не дефект.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Тот же список, что у headless-каркаса: одно требование — одно понятие. */
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
 * Исключения — по пути и с причиной, а не по вкусу.
 *
 * `tokens/tokens.ts` — в стеке гарнитур стоит ключевое слово CSS `system-ui`;
 * сканер видит в нём слово `system`, и это единственный способ его не видеть,
 * кроме как перестать разбивать составные имена, — а на этом разборе держится
 * ловля `terrainBrush`.
 *
 * `gallery/` — контрольный случай визуального языка стоит вместо редактируемого
 * материала: у него настоящие имена компонентов и полей, и в этом весь смысл
 * (ED-22 проверяется на плотном инспекторе, а не на «поле 1»). Каркасом он не
 * является — приложение с приходом W2-2 монтирует не его.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  'tokens/tokens.ts': 'system-ui — ключевое слово CSS, а не имя редактируемого',
  'gallery/': 'контрольный случай визуального языка, а не каркас',
};

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

describe('ED-25: каркас интерфейса без доменных имён редактируемого', () => {
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

  it('рабочие области пакета объявлены вкладами и потому исключены', () => {
    // Проверка самого исключения: файлы областей обязаны нести маркер, иначе
    // «зелено» означало бы только то, что доменных имён нет вообще нигде.
    const areas = files.filter((file) => file.slice(SRC.length).startsWith('areas/'));
    expect(areas.length).toBeGreaterThanOrEqual(2);
    for (const file of areas) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('@contribution'), file).toBe(true);
      expect(domainWordsIn(source).length, file).toBeGreaterThan(0);
    }
  });

  it('сканер видит доменное ветвление', () => {
    expect(domainWordsIn("if (area.id === 'scene') return terrainPanel;")).toEqual([
      'scene',
      'terrain',
    ]);
    expect(domainWordsIn('const prefabZone = [];')).toEqual(['prefab']);
    expect(domainWordsIn('// про террейн и prefab здесь только в комментарии')).toEqual([]);
    expect(domainWordsIn('const filesystemPath = "";')).toEqual([]);
  });
});
