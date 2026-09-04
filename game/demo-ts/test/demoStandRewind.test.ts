/**
 * Ульта отката на ВЫДЕЛЕННОМ стенде (`bin/demo-serve.mjs`, `npm run demo:serve`).
 *
 * Стенд поднимает матч не так, как вкладка: вкладка собирает конфиг кодом
 * (`app/match.ts`), а стенд раскладывает документ матча помощником запускалок
 * `@fluxus/net/bin/matchFile.mjs` — тем же, которым его раскладывает
 * `serve.mjs`. Ровно на этом шве ульта и терялась: раскладка перечисляла секции
 * поимённо и не называла `rewind`, поэтому `MatchServer` собирался БЕЗ истории,
 * `$rewind/request` отбрасывался, а игрок видел ульту, которая жжёт cooldown и
 * не двигает мир. Во вкладке путь был цел — оттого 79 тестов перемотки и
 * оставались зелёными.
 *
 * Предмет теста поэтому не механизм перемотки (он закрыт тестами ядра, сети и
 * оболочки), а ДОРОГА до него: настоящий документ матча → конфиг → сервер →
 * запрос из настоящей сцены → `Rewinding`.
 *
 * Дерево контента читается напрямую: это тест ИГРЫ, и `content/` для него —
 * свои данные (CONT-1, CONT-4). Тому же слою в `engine/` это было бы запрещено,
 * поэтому раскладка как таковая проверяется формой документа —
 * `engine/net-ts/test/matchFile.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { tick, world as coreWorld, type SceneDef } from '@fluxus/core';
import {
  MatchServer,
  buildMatchWorld,
  contentPack,
  type ClientMessage,
  type MatchConfig,
} from '@fluxus/net';
import {
  CLIENT_BUILD_FIELDS,
  MATCH_DOCUMENT_FIELDS,
  matchConfigOf,
  readMatchFile,
} from '@fluxus/net/bin/matchFile.mjs';
import {
  DEMO_CLIENT_BUILD_FIELDS,
  DEMO_DOCUMENT_FIELDS,
  demoClientBuildOptions,
  demoContentPack,
  demoMatchConfig,
  demoMatchConfigOf,
  type DemoDocuments,
} from '../app/match.js';
import { demoDocuments } from './fixtures.js';
import { ACTION_BITS } from '../app/sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

const MATCH_PATH = fileURLToPath(
  new URL('../../../content/matches/duel.match.json', import.meta.url),
);
const SCENE = sceneJson as unknown as SceneDef;

/** Секция `navigation` документа матча (NTR-14) — как её читает человек. */
const DOCUMENT_NAVIGATION = (matchJson as { readonly navigation?: Record<string, number> })
  .navigation;

/** Секция `rewind` документа матча — как её читает человек, открыв файл. */
const DOCUMENT_REWIND = (matchJson as { readonly rewind?: Record<string, unknown> }).rewind;

const REWIND_BIT = 1 << ACTION_BITS.rewind;

/**
 * Документы контент-пака страницы — ПРОЧИТАННЫЕ из того же дерева, по которому
 * стенд читает файл матча (`game-content` CONT-5). Именно в этом теперь состоит
 * сверка двух дорог: одно дерево, два читателя, один `MatchConfig`.
 */
let documents: DemoDocuments;

beforeAll(async () => {
  documents = await demoDocuments();
});

/** Тиков до готовности ульты в сцене прогона — см. `sceneWithReadyUlt`. */
const READY_TICKS = 20;

/**
 * Сцена стенда с УКОРОЧЕННЫМ стартовым cooldown'ом ульты. Правится ровно одно
 * число, и оно балансное: стартовый остаток сцены — противопетлевая мера
 * (он обязан превышать глубину отката, иначе перемотка достаёт до тика, когда
 * слоты ещё не выданы), и держит это неравенство `demoAbilities.test.ts`.
 *
 * Предмет ЭТОГО теста — дорога запроса до сервера, и секунды ожидания в ней не
 * проверяют ничего, зато стоят прогону минуты чужого времени: тесты пакета идут
 * параллельно, и соседний файл начинает падать по тайм-ауту.
 */
function sceneWithReadyUlt(): SceneDef {
  // Клон СВОЙ, и правится в нём одно число. `readonly` документа снимается
  // точечно — на самом компоненте: приведение всей сцены к изменяемой форме
  // заодно снимало бы readonly с массива префабов, о чём в сигнатуре не сказано
  // ни слова.
  const scene = structuredClone(SCENE);
  const slot = scene.prefabs?.find((prefab) => prefab.name === 'SlotRewind');
  expect(slot).toBeDefined();
  const cooldown = slot!.components.AbilityCooldown;
  expect(cooldown).toBeDefined();
  (cooldown as Record<string, number>).remaining = READY_TICKS;
  return scene;
}

/** Конфиг матча ровно тем путём, каким его собирает стенд. */
function standConfig(scene?: SceneDef): MatchConfig {
  const match = readMatchFile(MATCH_PATH);
  const scenes = scene === undefined ? match.scenes! : { [match.sceneRef!]: scene };
  return matchConfigOf(match, contentPack(scenes));
}

/**
 * Матч стенда без транспорта (NTR-3): оба слота заняты, ввод подаётся
 * сообщениями прямо серверу, темп двигает тест. Кадр адресуется тику
 * `tick + inputDelay` — нижней границе адаптивного запаса разметки клиента
 * (NTR-7); сама адаптация к предмету этой проверки отношения не имеет, а на
 * канале без плеча запас с этой границы и не уходит.
 */
function standMatch(config: MatchConfig) {
  const server = new MatchServer(config);
  let seq = 0;
  const hello = (playerId: string): ClientMessage => ({
    type: 'Hello',
    playerId,
    version: config.version,
    // Роль соединения — обязательное поле `Hello` (NTR-4, NTR-18); за свой слот
    // до старта входит владелец.
    role: 'owner',
    observer: false,
  });
  config.players.forEach((playerId, slot) => {
    server.connect(slot + 1);
    server.receive(slot + 1, hello(playerId));
  });
  server.drain();

  /** Один тик расписания с вводом первого слота. */
  const step = (buttons: number): void => {
    seq++;
    server.receive(1, {
      type: 'Input',
      epoch: server.epoch,
      frames: [
        {
          tick: server.tick + (config.inputDelay ?? 2),
          seq,
          moveX: 0,
          moveY: 0,
          aimDir: 0,
          buttons,
        },
      ],
    });
    server.advance();
    server.drain();
  };

  return { server, step };
}

/**
 * Прожать ульту и дождаться входа в перемотку. Бит МИГАЕТ, а не держится: каст
 * идёт по фронту кнопки (определение `rewind` сцены), и удержание дало бы ровно
 * один фронт — на первом тике, когда ульта ещё на cooldown'е.
 */
function castUlt(m: ReturnType<typeof standMatch>): boolean {
  for (let ticks = 0; ticks < READY_TICKS + 32; ticks++) {
    if (m.server.mode !== 'Running') return true;
    m.step(ticks % 2 === 0 ? REWIND_BIT : 0);
  }
  return m.server.mode !== 'Running';
}

describe('раскладка документа матча одна на обе сборки (NTR-14, NTR-5)', () => {
  it('конфиг вкладки совпадает с конфигом запускалок на том же документе', () => {
    const pack = demoContentPack(documents);
    expect(demoMatchConfig(documents, pack)).toEqual(matchConfigOf(readMatchFile(MATCH_PATH), pack));
  });

  it('teams, inputWindow и eventRepeat доезжают до сервера и во вкладке (РЕГРЕССИЯ)', () => {
    // РЕГРЕССИЯ: раскладка вкладки перечисляла поля поимённо и молча теряла
    // эти три секции — стенд их вёз (`matchConfigOf`), а страница нет, и один
    // документ матча поднимал два разных матча в зависимости от режима:
    // команды и туман войны (NET-12), окно ввода (NTR-7), повтор событий
    // (NTR-15). Тот же фасад дефекта, что и потерянная секция `rewind` ниже.
    const document = { ...documents.match, teams: [0, 0], inputWindow: 8, eventRepeat: 1 };
    const pack = demoContentPack(documents);
    const config = demoMatchConfigOf(document, pack);
    expect(config.teams).toEqual([0, 0]);
    expect(config.inputWindow).toBe(8);
    expect(config.eventRepeat).toBe(1);
    expect(config).toEqual(matchConfigOf(document, pack));
  });

  it('опечатанная секция роняет сборку вкладки тем же отказом, что у запускалок', () => {
    const document = { ...documents.match, rewnd: { interval: 30 } };
    expect(() => demoMatchConfigOf(document, demoContentPack(documents))).toThrow(/"rewnd"/);
    expect(() => matchConfigOf(document, demoContentPack(documents))).toThrow(/"rewnd"/);
  });

  it('документ объявляет поиск пути, и мир матча его печёт (NTR-14, NAV-1)', () => {
    // Навигация — зависимость сборки наравне с физикой и видимостью: документ
    // её называет, обе стороны берут ЕЁ ЖЕ (NTR-14), и без места в конфиге
    // матча движение NPC по путям (NPC-6) было бы недостижимо ни в одной игре.
    const config = standConfig();
    expect(config.navigation).toEqual(DOCUMENT_NAVIGATION);
    expect(config.navigation?.budget).toBeGreaterThan(0);
    const built = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      ...(config.initial !== undefined ? { initial: config.initial } : {}),
      ...(config.physics !== undefined ? { physics: config.physics } : {}),
      ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
      ...(config.navigation !== undefined ? { navigation: config.navigation } : {}),
    });
    expect(built.sim.navigation).toBeDefined();
    // Путь по арене демо ищется, а не отвечает «недостижимо»: сетка сцены и
    // числа документа сходятся друг с другом.
    const found = built.sim.navigation!.findPath(
      { x: 557056, y: 1605632 },
      { x: 2588672, y: 1605632 },
    );
    expect(found.status).toBe('found');

    // И NPC арены этим пользуются: в своё окно решений агент берёт очередную
    // точку пути (NPC-6). Без этого объявление навигации было бы мёртвым, а
    // отладочный источник нитей пути (`demo.navPaths`) не имел бы что рисовать.
    let held = 0;
    for (let t = 0; t < 120 && held === 0; t++) {
      tick(built.sim, built.state);
      held = coreWorld
        .listAlive(built.state.world)
        .filter(
          (entity) =>
            coreWorld.hasComponent(built.state.world, entity, 'NpcAgent') &&
            coreWorld.getField(built.state.world, entity, 'NpcAgent', 'pathValid') === 1,
        ).length;
    }
    expect(held).toBeGreaterThan(0);
  });

  it('стенд отдаёт ботам зависимости сборки общей раскладкой (NTR-14, NTR-10)', () => {
    // Бот предсказывает тики (NTR-10) и обязан тикать тем же составом, что
    // сервер: навигация, собранная у одной стороны и не собранная у другой,
    // водила бы NPC разными дорогами при формально одном мире. Проверяется по
    // исходнику — исполнить стенд тест не может: он поднимает сервер и слушает
    // порт.
    const source = readFileSync(
      fileURLToPath(new URL('../bin/demo-serve.mjs', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('clientBuildOptions(match)');
    for (const field of CLIENT_BUILD_FIELDS) {
      expect(source, field).not.toContain(`{ ${field}: match.${field} }`);
    }
  });

  it('список полей документа вкладки — тот же, что у запускалок', () => {
    // Совпадение списков держит тип кортежа (`npm run typecheck`); здесь —
    // что объявление типов (`matchFile.d.mts`) не разошлось с `matchFile.mjs`.
    expect([...DEMO_DOCUMENT_FIELDS]).toEqual([...MATCH_DOCUMENT_FIELDS]);
  });

  it('раскладка зависимостей сборки для клиента у вкладки та же, что у запускалок', () => {
    // Вторая запись того же списка нужна потому, что помощник запускалок тянет
    // `node:fs` и в сборку вкладки не входит. Разойтись им запрещено типом; тут
    // проверяется, что и значения не разошлись (NTR-14, NTR-10).
    expect([...DEMO_CLIENT_BUILD_FIELDS]).toEqual([...CLIENT_BUILD_FIELDS]);
    // Сверка СПИСКОМ, а не переписанными именами: секция, добавленная в список
    // и забытая в теле раскладки, краснеет здесь.
    const config = standConfig();
    const carried = config as unknown as Record<string, unknown>;
    expect(Object.keys(demoClientBuildOptions(config)).sort()).toEqual(
      [...DEMO_CLIENT_BUILD_FIELDS].filter((field) => carried[field] !== undefined).sort(),
    );
    expect(demoClientBuildOptions(config).navigation).toEqual(config.navigation);
  });
});

describe('стенд демо: ульта отката доезжает до сервера (NET-11, NTR-14)', () => {
  it('раскладка документа матча несёт секцию rewind дословно', () => {
    expect(DOCUMENT_REWIND).toBeDefined();
    expect(standConfig().rewind).toEqual(DOCUMENT_REWIND);
  });

  it('бит удержания скраба в матче — тот же, что жмёт игрок в демо', () => {
    // Раскладку битов знает сборка игры, а не сетевой слой (NET-11): совпасть
    // они обязаны, иначе сервер ведёт точку по чужой кнопке.
    expect(standConfig().rewind?.holdButton).toBe(ACTION_BITS.rewind);
  });

  it('сервер стенда собрал механизм перемотки, а не поднялся без истории', () => {
    const server = new MatchServer(standConfig());

    // `pause()` без контроллера бросает: проверка на собранную историю, а не на
    // непустое поле конфига.
    expect(() => { server.pause(); }).not.toThrow();
    expect(server.mode).toBe('Paused');
    server.beginRewind();
    expect(server.mode).toBe('Rewinding');
    server.pause();
    server.resume();
    expect(server.mode).toBe('Running');
  });

  /**
   * Дорога целиком — от каста до возобновления — одной проверкой, а не тремя:
   * каждая начиналась бы с ожидания готовности ульты, то есть прогоняла бы
   * настоящую сцену заново.
   */
  it('запрос из настоящей сцены уводит матч в Rewinding, ведёт точку и возвращает мир', () => {
    const config = standConfig(sceneWithReadyUlt());
    const m = standMatch(config);
    expect(m.server.mode).toBe('Running');

    expect(castUlt(m)).toBe(true);
    expect(m.server.mode).toBe('Rewinding');
    const castTick = m.server.tick;

    // Цикл рассылки удержания — один шаг скраба назад (REW-13).
    const cycle = (config.tickRate ?? 60) / (config.snapshotRate ?? 30);
    for (let i = 0; i < cycle; i++) m.step(REWIND_BIT);
    expect(m.server.tick).toBe(castTick - config.rewind!.step!);

    // Бит отпущен — мир возобновляется с достигнутой точки (WSM-2).
    for (let i = 0; i < cycle && m.server.mode !== 'Running'; i++) m.step(0);
    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBeLessThan(castTick);
  });

  it('короткий тап по ульте двигает мир, а не сжигает её впустую (РЕГРЕССИЯ, REW-13)', () => {
    // РЕГРЕССИЯ на настоящем контенте. Драйвер скраба ждал целый цикл рассылки
    // до первого шага и только там читал отпускание: тап по клавише ульты
    // возвращал мир на ТОТ ЖЕ тик, потратив cooldown в 1200 тиков. Игрок видел
    // ульту, которая «не работает», — и это второй фасад того же дефекта, что и
    // потерянная секция `rewind`.
    const config = standConfig(sceneWithReadyUlt());
    const m = standMatch(config);
    expect(castUlt(m)).toBe(true);
    expect(m.server.mode).toBe('Rewinding');
    const castTick = m.server.tick;

    // Бита нет уже в первом кадре после каста — короче нажатия не бывает.
    const cycle = (config.tickRate ?? 60) / (config.snapshotRate ?? 30);
    for (let i = 0; i < cycle + 1 && m.server.mode !== 'Running'; i++) m.step(0);

    expect(m.server.mode).toBe('Running');
    expect(m.server.tick).toBe(castTick - config.rewind!.step!);
  });
});
