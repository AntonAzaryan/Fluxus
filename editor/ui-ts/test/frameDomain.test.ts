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
 * - Идентификаторы разбиваются по camelCase и сводятся к единственному числу;
 *   имя целиком из заглавных (`TERRAIN_KEY`) разбору по camelCase не поддаётся
 *   и потому берётся словом — иначе константа с доменным именем прошла бы мимо
 *   сканера ровно в том виде, в каком её и пишут.
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

/**
 * Сборка приложения лежит вне библиотеки (`app/`) и доменные имена называет по
 * определению: она и решает, ЧТО открывать и какие документы держать вместе
 * (ED-19, ED-21). Каркасом она при этом не является — ED-25 перечисляет каркас
 * поимённо, и сборки в этом перечне нет.
 *
 * Чтобы «вынесли из-под сканера» не стало способом обойти его, состав `app/`
 * назван здесь пофайлово и с причиной. Файл, появившийся там незаявленным,
 * красит проверку — и разговор о том, каркас это или сборка, случается при его
 * появлении, а не при следующем чтении кода.
 */
const APP_FILES: Readonly<Record<string, string>> = {
  'assembly.ts': 'сборка редактора: реестры вкладов, открытый проект, группы записи',
  'contentEndpoint.ts': 'серверная половина веб-хоста среды (ED-12)',
  'documentRefresh.ts': 'перечитывание документов, изменённых в дереве извне (ED-12, BLND-12)',
  'index.html': 'страница приложения',
  'main.ts': 'точка входа: выбор среды по наличию моста контейнера, заголовок вкладки, монтирование',
  'vite.config.ts': 'конфиг сборки приложения',
  'vite.desktop.config.ts': 'та же сборка для десктоп-контейнера, без копии дерева контента (DSK-4)',
};

/** Артефакты сборки: они в .gitignore и исходниками приложения не являются. */
const APP_ARTIFACTS = new Set(['dist', 'dist-desktop']);

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
const APP = fileURLToPath(new URL('../app/', import.meta.url));

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
    // SCREAMING_SNAKE_CASE разбивается подчёркиванием, а не регистром: разбор
    // по camelCase рассыпал бы `TERRAIN` на буквы и не нашёл бы в нём ничего.
    const parts = /^[A-Z][A-Z0-9]*$/.test(token) ? [token] : token.split(/(?=[A-Z])/);
    for (const part of parts) {
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

  it('вне библиотеки лежит только заявленное: сборка, а не вынесенный каркас', () => {
    // Сканер смотрит в `src/`, и «перенести файл в app/» не должно быть
    // способом выйти из-под него. Состав каталога поэтому назван поимённо.
    const present = readdirSync(APP).filter((entry) => !APP_ARTIFACTS.has(entry));
    expect(present.sort()).toEqual(Object.keys(APP_FILES).sort());
  });

  it('каркас в сборку не переехал: его модули по-прежнему в библиотеке', () => {
    // Утверждение о том, ГДЕ живёт каркас, а не только о том, что в нём нет
    // доменных имён: пустой `src/frame/` сделал бы сканер зелёным ни о чём.
    const frame = files.filter((file) => file.slice(SRC.length).startsWith('frame/'));
    expect(frame.length).toBeGreaterThan(5);
    for (const name of ['frame/frame.ts', 'frame/rail.ts', 'frame/skeleton.ts', 'frame/topBar.ts']) {
      expect(files.map((file) => file.slice(SRC.length)), name).toContain(name);
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
    // Вырезка — по вхождению имени, а не по файлу: настоящий `component` рядом
    // с `encodeURIComponent` в одном файле сканер видит.
    expect(domainWordsIn('encodeURIComponent(p); const componentName = 1;')).toEqual(['component']);
    expect(domainWordsIn('const COMPONENT_NAME = 1;')).toEqual(['component']);
  });

  it('сканер видит доменное имя в константе из заглавных', () => {
    // Так их и пишут: `POSITION_COMPONENT`, `TERRAIN_PREFAB`. Разбор по
    // camelCase на таком имени не срабатывает вовсе, и без отдельного правила
    // каркас мог бы назвать редактируемое именно так — незамеченным.
    expect(domainWordsIn('const TERRAIN_KEY = 1;')).toEqual(['terrain']);
    expect(domainWordsIn('import { SCENE_PREFAB } from "x";')).toEqual(['prefab', 'scene']);
    expect(domainWordsIn('const FILL_CLASS = 1;')).toEqual([]);
  });
});
