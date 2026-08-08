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
 * - Ключевые слова CSS вырезаются до разбора: `system-ui` — имя гарнитуры, а
 *   не редактируемого, и вырезано именно оно, а не файл, в котором стоит.
 * - Файл, объявивший себя вкладом маркером `@contribution` в шапке, исключён:
 *   вклад и есть место доменного знания, и рабочие области пакета — вклады.
 *   Маркер — заявление о себе, поэтому проверяется и обратное: файлам самого
 *   каркаса заявлять себя вкладом нельзя, иначе запрет снимается изнутри.
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
 * Имена, в которых сканеру мерещится доменное: ключевое слово CSS и функции
 * платформы. Вырезаются из любого файла, а не служат поводом не смотреть в файл
 * целиком: `system-ui` стоит в стеке гарнитур, а `encodeURIComponent` — в
 * сборке URL хостом среды, и исключить из-за них весь набор токенов или весь
 * шов среды значило бы завести в пакете место, куда доменное имя можно
 * положить незамеченным.
 */
const FOREIGN_NAMES: readonly string[] = ['system-ui', 'encodeURIComponent', 'decodeURIComponent'];

/**
 * Исключения — по пути и с причиной, а не по вкусу. Оно здесь одно.
 *
 * `gallery/` — контрольный случай визуального языка стоит вместо редактируемого
 * материала: у него настоящие имена компонентов и полей, и в этом весь смысл
 * (ED-22 проверяется на плотном инспекторе, а не на «поле 1»). Каркасом он не
 * является и вкладом тоже: приложение монтирует каркас, а не его, и ED-25
 * запрещает доменные имена каркасу — не всякому файлу пакета.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
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

function stripForeignNames(source: string): string {
  let text = source;
  for (const name of FOREIGN_NAMES) text = text.split(name).join(' ');
  return text;
}

function domainWordsIn(source: string): string[] {
  const words = new Set<string>();
  for (const [token] of stripForeignNames(stripComments(source)).matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
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

  it('файлы каркаса не могут объявить себя вкладом и выйти из-под проверки', () => {
    // Маркер — заявление «здесь доменному знанию место». Каркас — ровно то, о
    // чём ED-25 говорит обратное, и снять с него проверку одной строкой в шапке
    // не должно быть можно: иначе зелёный тест означает лишь, что кто-то так
    // написал. Исключений по пути у каркаса нет по той же причине.
    const frame = files.filter((file) => file.slice(SRC.length).startsWith('frame/'));
    expect(frame.length).toBeGreaterThan(0);
    for (const file of frame) {
      const relative = file.slice(SRC.length);
      expect(readFileSync(file, 'utf8').includes('@contribution'), relative).toBe(false);
      expect(
        Object.keys(EXCEPTIONS).some((excluded) => relative.startsWith(excluded)),
        relative,
      ).toBe(false);
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

  it('вырезано ключевое слово CSS, а не слово `system` вообще', () => {
    expect(domainWordsIn("const font = 'Inter, system-ui, sans-serif';")).toEqual([]);
    expect(domainWordsIn('const systemPanel = 1;')).toEqual(['system']);
    expect(domainWordsIn("const kind = 'system';")).toEqual(['system']);
  });

  it('вырезано имя платформы, а не слово `component` вообще', () => {
    expect(domainWordsIn('const url = encodeURIComponent(path);')).toEqual([]);
    expect(domainWordsIn('const componentName = 1;')).toEqual(['component']);
  });
});
