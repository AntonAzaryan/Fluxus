/**
 * Документы контент-пака страница читает ИЗ РАЗДАЧИ (`game-content` CONT-5):
 * загрузчик демо (`app/match.ts`) над источником байтов дерева контента.
 *
 * Предмет теста — совпадение двух дорог до одного матча: загрузчик страницы и
 * помощник запускалок (`@fluxus/net/bin/matchFile.mjs`) обязаны дать один и тот
 * же `MatchConfig` — и, главное, одну и ту же версию (NET-16, NET-17). Разойдись
 * они, вход отклонялся бы по хешу контент-пака (NTR-5), и наблюдалось бы это
 * «меня не пускают в мой же матч», а не сообщением о причине.
 *
 * Дерево контента читается напрямую: это тест ИГРЫ, и `content/` для него —
 * свои данные (CONT-1, CONT-4).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentPack, type MatchConfig } from '@fluxus/net';
import { matchConfigOf, readMatchFile } from '@fluxus/net/bin/matchFile.mjs';
import {
  DEMO_MATCH_ID,
  demoContentId,
  demoMatchConfig,
  loadDemoDocuments,
  type DemoDocuments,
} from '../app/match.js';
import { contentSource, demoDocuments } from './fixtures.js';

const CONTENT_ROOT = fileURLToPath(new URL('../../../content/', import.meta.url));
const MATCH_PATH = join(CONTENT_ROOT, DEMO_MATCH_ID);

/** Источник байтов в памяти: дерево, которого на диске нет, — для отказов. */
function memorySource(files: Readonly<Record<string, string>>): {
  read(id: string): Promise<ArrayBuffer>;
} {
  return {
    read(id: string): Promise<ArrayBuffer> {
      const text = files[id];
      if (text === undefined) return Promise.reject(new Error(`HTTP 404 за документом "${id}"`));
      return Promise.resolve(new TextEncoder().encode(text).buffer);
    },
  };
}

describe('загрузчик документов демо читает дерево так же, как запускалка (CONT-5)', () => {
  let documents: DemoDocuments;

  beforeAll(async () => {
    documents = await demoDocuments();
  });

  it('конфиг матча страницы совпадает с конфигом запускалки на том же дереве', () => {
    const launcher = readMatchFile(MATCH_PATH);
    const expected: MatchConfig = matchConfigOf(launcher, contentPack(launcher.scenes!));
    expect(demoMatchConfig(documents)).toEqual(expected);
  });

  it('версия — та же половина, что предъявляется в рукопожатии (NET-16, NET-17)', () => {
    // Именно версия и есть предмет всего change'а: `buildId` из документа плюс
    // хеш контент-пака, посчитанный ИЗ ПРОЧИТАННОГО, а не из снимка сборки.
    const launcher = readMatchFile(MATCH_PATH);
    expect(demoMatchConfig(documents).version).toEqual({
      buildId: launcher.buildId,
      contentPackHash: contentPack(launcher.scenes!).hash,
    });
  });

  it('ссылка контент-пака разрешается относительно документа матча в ID-путь', () => {
    // Правило CONT-5, зеркало `resolve(dirname(file), scenePath)` запускалок:
    // `matches/duel.match.json` + `../scenes/duel.scene.json` → ID сцены.
    expect(demoContentId(DEMO_MATCH_ID, '../scenes/duel.scene.json')).toBe(
      'scenes/duel.scene.json',
    );
    expect(demoContentId(DEMO_MATCH_ID, './duel.scene.json')).toBe('matches/duel.scene.json');
    expect(documents.sceneIds[documents.match.sceneRef]).toBe('scenes/duel.scene.json');
  });

  it('ссылка за корень дерева — названный отказ, а не выдуманный адрес', () => {
    expect(() => demoContentId(DEMO_MATCH_ID, '../../secrets/duel.scene.json')).toThrow(
      /за корень дерева контента/,
    );
    // Не относительная ссылка отвергается отдельно: «от корня» и «относительно
    // документа» — разные правила, и молча считать первое вторым нельзя (CONT-5).
    expect(() => demoContentId(DEMO_MATCH_ID, '/scenes/duel.scene.json')).toThrow(
      /не относительная/,
    );
  });

  it('отказ раздачи называет ID документа, а не тонет в тексте ошибки транспорта', async () => {
    const empty = memorySource({});
    await expect(loadDemoDocuments(empty)).rejects.toThrow(new RegExp(DEMO_MATCH_ID));
    // Сцены это касается наравне с документом матча: пропавший конфиг сцены —
    // такая же дыра в раздаче, и назван он обязан быть своим ID.
    const noScene = memorySource({
      [DEMO_MATCH_ID]: JSON.stringify({
        name: 'duel',
        buildId: 'x',
        seed: 1,
        players: ['p1'],
        sceneRef: 'duel',
        contentPack: { duel: '../scenes/duel.scene.json' },
      }),
    });
    await expect(loadDemoDocuments(noScene)).rejects.toThrow(/scenes\/duel\.scene\.json/);
  });

  it('битый JSON документа назван разбором, а не отсутствием', async () => {
    const broken = memorySource({ [DEMO_MATCH_ID]: '{ "name": ' });
    await expect(loadDemoDocuments(broken)).rejects.toThrow(/не разобран как JSON/);
  });

  it('опечатка в раздаваемом документе — названный отказ раскладки, а не молчание', async () => {
    // Документ из раздачи правит дизайнер, а не сборка: опечатка в секции —
    // обычное состояние правленого дерева. Читается он при этом успешно, и
    // отказ приходит от РАСКЛАДКИ (`demoMatchConfigOf`) — той самой, которую
    // страница зовёт на главном потоке до спавна воркеров, чтобы причина
    // доехала человеку, а не умерла в воркере (CONT-5, NTR-14).
    const typo = memorySource({
      [DEMO_MATCH_ID]: JSON.stringify({
        ...(JSON.parse(readFileSync(MATCH_PATH, 'utf8')) as Record<string, unknown>),
        rewnd: { interval: 30 },
      }),
      'scenes/duel.scene.json': readFileSync(join(CONTENT_ROOT, 'scenes/duel.scene.json'), 'utf8'),
    });
    const served = await loadDemoDocuments(typo);
    expect(() => demoMatchConfig(served)).toThrow(/"rewnd"/);
  });
});

/** Число, которым «дизайнер» правит сцену в копии дерева: подпись правки. */
const EDITED_COOLDOWN = 123;

describe('правка сцены в раздаваемом дереве доезжает до страницы (CONT-5)', () => {
  let work: string;
  let root: string;

  beforeAll(() => {
    // Дерево-копия: правится сцена, а сборка приложения — нет. Ровно сценарий
    // «Правка сцены в раздаваемом дереве» и «Правка контента внутри
    // дистрибутива» (SRV-7): сервер и страница читают ОДНО дерево.
    work = mkdtempSync(join(tmpdir(), 'demo-documents-'));
    root = join(work, 'content');
    mkdirSync(join(root, 'matches'), { recursive: true });
    mkdirSync(join(root, 'scenes'), { recursive: true });
    writeFileSync(join(root, DEMO_MATCH_ID), readFileSync(MATCH_PATH, 'utf8'));
    const scenePath = join(root, 'scenes/duel.scene.json');
    const scene = JSON.parse(
      readFileSync(join(CONTENT_ROOT, 'scenes/duel.scene.json'), 'utf8'),
    ) as { abilities: { cooldownTicks?: number }[] };
    // Правка дизайнера — перетюнили cooldown способности: правило, а не
    // оформление, поэтому хеш контент-пака обязан от неё сдвинуться (NET-17).
    scene.abilities[0]!.cooldownTicks = EDITED_COOLDOWN;
    writeFileSync(scenePath, `${JSON.stringify(scene, null, 2)}\n`);
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('хеш контент-пака у страницы и у запускалки меняется одинаково', async () => {
    const edited = await loadDemoDocuments(contentSource(root));
    const launcher = readMatchFile(join(root, DEMO_MATCH_ID));
    const expected = contentPack(launcher.scenes!).hash;

    expect(demoMatchConfig(edited).version.contentPackHash).toBe(expected);
    // И это ДРУГОЙ хеш, чем у нетронутого дерева: иначе тест не отличал бы
    // «правка доехала» от «правку не заметил никто».
    const original = await demoDocuments();
    expect(expected).not.toBe(demoMatchConfig(original).version.contentPackHash);
  });

  it('дерево-копия читается тем же загрузчиком: корень — свойство оболочки', async () => {
    // «Путь до корня дерева контента задаётся оболочкой» (CONT-5): загрузчик
    // получает источник байтов, а не путь, и второй раскладки ID в путь у
    // приложения не появляется. Проверяется это ПО СОДЕРЖИМОМУ: сцена пришла
    // именно из копии — с правленым числом, — а не из дерева репозитория, где
    // прежнее. Иначе тест прошёл бы и у загрузчика, который источник
    // проигнорировал.
    const edited = await loadDemoDocuments(contentSource(root));
    const scene = edited.scenes[edited.match.sceneRef] as unknown as {
      abilities: { cooldownTicks?: number }[];
    };
    expect(scene.abilities[0]!.cooldownTicks).toBe(EDITED_COOLDOWN);
    expect(Object.keys(edited.scenes)).toEqual([edited.match.sceneRef]);
  });
});
