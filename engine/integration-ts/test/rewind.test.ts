/**
 * Матч с перемоткой в вертикали (NET-11, NTR-16, NTR-8): сервер перематывает
 * мир посреди loopback-матча, клиенты видят это как разрыв непрерывности, а
 * записанный сегментами лог прогоняется побитово в то же состояние.
 *
 * Почему это здесь, а не в `net-ts`. Проверка парности записи и прогона (NTR-8)
 * у матча с перемоткой перестаёт быть проверкой одного пакета: лог пишет
 * сервер, разрыв читает клиент, snap рисует рендер, и разойтись они могут
 * попарно. Собирается всё из публичных поверхностей (CLI-9) — как это делает
 * запускалка, а не тесты пакетов.
 *
 * Golden-записи такой матч не порождает намеренно: плоская форма документа
 * сценария (CLI-2) сегментов не держит, и `toScenario()` на таком матче честно
 * отказывает. Парность здесь проверяется в памяти, прогоном `replaySegments`.
 */
import { describe, expect, it } from 'vitest';
import {
  query,
  runScenario,
  snapshotToPlain,
  world as coreWorld,
  type SceneDef,
} from '@game-mvp/core';
import {
  replaySegments,
  REWIND_REQUEST_EVENT,
  type InputSource,
  type MatchSegment,
  type PresentedState,
} from '@game-mvp/net';
import {
  RenderBridge,
  STEP,
  TICK_RATE,
  connectClient,
  duelConfig,
  duelScene,
  harness,
  playMatch,
  settle,
  walkRight,
} from './fixtures.js';

const TICKS_BEFORE = 12;
const REWIND_TO = 6;
const TICKS_AFTER = 8;

/**
 * Ввод, зависящий от порядка вызова, а не от номера тика. Функция от тика после
 * перемотки вернула бы в новой ветви ровно тот же ввод — ветви истории вышли бы
 * неразличимыми, и прогон сегментов совпал бы с сервером даже при сломанной
 * сегментации.
 */
function turnAround(afterCalls: number): InputSource {
  let calls = 0;
  return () => {
    calls++;
    return { move: { x: calls <= afterCalls ? STEP : -STEP, y: 0 }, aimDir: 0, buttons: 0 };
  };
}

interface Rendered {
  readonly tick: number;
  readonly epoch: number;
  readonly snapAll: boolean;
}

async function playRewoundMatch() {
  const config = duelConfig({ rewind: { interval: 1, capacity: 64 } });
  const fixture = harness(config);
  const scene = config.scene;
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, turnAround(TICKS_BEFORE));
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene);
  const bridge = new RenderBridge(scene, config, fixture.clock);
  await settle();

  /** То, что реально доехало до рендера: по записи видно и порядок, и snap. */
  const rendered: Rendered[] = [];
  const deliver = (): void => {
    const discontinuity = b.client.takeDiscontinuity();
    const latest = b.client.latest;
    if (latest === undefined) return;
    bridge.apply(latest, b.client.epoch, discontinuity);
    rendered.push({
      tick: bridge.host.view.tick,
      epoch: b.client.epoch,
      snapAll: bridge.host.view.snapAll,
    });
  };

  const tick = async (): Promise<void> => {
    fixture.clock.ms += 1000 / TICK_RATE;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
    deliver();
  };

  for (let i = 0; i < TICKS_BEFORE; i++) await tick();
  const beforeRewind = fixture.server.snapshot();

  // Единственный разрешённый флоу (NET-11, WSM-2): мир замирает, скрабится,
  // продолжается с выбранного тика.
  fixture.server.pause();
  fixture.server.beginRewind();
  fixture.server.seekTo(REWIND_TO);
  fixture.server.pause();
  fixture.server.resume();
  // Снимается уже в `Running`: этим состоянием проверяется мост, и разрыв в нём
  // обязан читаться из признака клиента, а не из смены режима мира.
  const restored = fixture.server.snapshot();
  // Восстановленное состояние уехало по факту восстановления, мимо расписания
  // рассылки (NTR-16), поэтому доставка — flush без шага расписания.
  fixture.host.flush();
  await settle();
  deliver();

  for (let i = 0; i < TICKS_AFTER; i++) await tick();

  return { ...fixture, a, b, bridge, config, rendered, beforeRewind, restored };
}

function replayOf(config: ReturnType<typeof duelConfig>, segments: readonly MatchSegment[]) {
  return replaySegments({
    scene: config.scene,
    seed: config.seed,
    players: config.players,
    ...(config.initial !== undefined ? { initial: config.initial } : {}),
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    segments,
  });
}

/** Позиция героя слота — чем и видно, что состояния двух ветвей разные. */
function slotX(snapshot: PresentedState, slot: number): number {
  for (const entity of query(snapshot.world, { all: ['Player', 'Position'] })) {
    if (coreWorld.getField(snapshot.world, entity, 'Player', 'slot') !== slot) continue;
    return coreWorld.getField(snapshot.world, entity, 'Position', 'x');
  }
  throw new Error(`слот ${slot} не найден в снапшоте`);
}

function movesOf(segment: MatchSegment, tick: number): number[] {
  return segment.frames
    .filter((frame) => frame.tick === tick && frame.playerId === 'p1')
    .map((frame) => frame.move.x);
}

describe('матч с перемоткой в вертикали (NET-11, NTR-16)', () => {
  it('сегментированный лог прогоняется побитово в то же состояние (NTR-8)', async () => {
    const match = await playRewoundMatch();
    const segments = match.server.canonicalSegments;

    expect(segments.map((segment) => segment.epoch)).toEqual([0, 1]);
    // Точка возобновления записана самим логом: первый кадр второго сегмента и
    // есть тик, с которого мир пошёл заново (NTR-16).
    expect(segments[1]!.frames[0]!.tick).toBe(REWIND_TO + 1);
    expect(match.server.tick).toBe(REWIND_TO + TICKS_AFTER);
    // Ветви разошлись по-настоящему: тот же номер тика исполнен в двух эпохах с
    // разным вводом. Иначе прогон совпал бы с сервером и при сломанной
    // сегментации — просто потому, что обе ветви одинаковы.
    expect(movesOf(segments[0]!, REWIND_TO + 4)[0]).toBeGreaterThan(0);
    expect(movesOf(segments[1]!, REWIND_TO + 4)[0]).toBeLessThan(0);
    // А первые тики новой ветви идут на повторе кадра, применённого на тике
    // восстановления (NTR-7): свой ввод клиент отдаёт только после того, как
    // увидит возобновлённый мир, и до тех пор повторяется кадр тика 6, а не
    // последний полученный сервером кадр стёртого будущего.
    expect(movesOf(segments[1]!, REWIND_TO + 1)[0]).toBe(movesOf(segments[0]!, REWIND_TO)[0]);

    const replay = replayOf(match.config, segments);
    expect(replay.worldInitHash).toBe(match.server.worldInitHash);
    expect(replay.tick).toBe(match.server.tick);
    // Побитово: rng, шина событий и режим мира, а не только позиции.
    expect(snapshotToPlain(replay.snapshot)).toEqual(snapshotToPlain(match.server.snapshot()));

    // Записать такой матч golden-сценарием нечем, и отказ явный (CLI-2): один
    // номер тика исполнен дважды, и плоский список с ключом-тиком назвал бы им
    // два разных кадра.
    expect(() => match.server.toScenario()).toThrow(/сегмент/);
  });

  it('перемотка доезжает до рендера и рисуется snap\'ом (NET-11, SHELL-7)', async () => {
    const match = await playRewoundMatch();

    expect(match.b.client.epoch).toBe(1);
    // Единственное место записи, где номер тика уменьшился, — та самая
    // перемотка. Дедуп по одному номеру тика погасил бы её (NTR-10).
    const back = match.rendered.findIndex(
      (entry, index) => index > 0 && entry.tick < match.rendered[index - 1]!.tick,
    );
    expect(back).toBeGreaterThan(0);
    expect(match.rendered[back]).toEqual({ tick: REWIND_TO, epoch: 1, snapAll: true });
    // Дальше мир идёт вперёд по тем же номерам заново. Первый живой тик после
    // возобновления рисуется snap'ом ещё раз — но уже по своему основанию:
    // сменился режим мира, `Rewinding → Running` (REND-2). Разрывом от смены
    // эпохи он не является, и следующий за ним тик идёт обычным порядком.
    expect(match.rendered[back + 1]).toEqual({ tick: REWIND_TO + 1, epoch: 1, snapAll: true });
    expect(match.rendered[back + 2]).toEqual({ tick: REWIND_TO + 2, epoch: 1, snapAll: false });
    expect(match.bridge.host.view.tick).toBe(match.server.tick);
  });

  it('мост дедуплицирует по паре, а не по номеру тика (NTR-10, NTR-16)', async () => {
    const match = await playRewoundMatch();
    // Отдельный мост: проверяется правило применения, а не пройденный матч.
    const bridge = new RenderBridge(match.config.scene, match.config, match.clock);
    // Состояния двух ветвей действительно разные — иначе «применилось» и
    // «погашено» были бы неразличимы по любому наблюдаемому следствию.
    expect(slotX(match.restored, 0)).not.toBe(slotX(match.beforeRewind, 0));

    bridge.apply(match.beforeRewind, 0, false);
    expect(bridge.host.view.tick).toBe(TICKS_BEFORE);
    expect(bridge.host.view.snapAll).toBe(false);

    // Перемотанное состояние: номер тика МЕНЬШЕ показанного, а пара больше.
    bridge.apply(match.restored, 1, true);
    expect(bridge.host.view.tick).toBe(REWIND_TO);
    // Режим мира при этом не менялся — оба состояния `Running`. Значит `snapAll`
    // выведен из признака разрыва, приехавшего от клиента, и захардкоженный
    // `isReplay: false` оставил бы рендер интерполировать между ветвями истории
    // (REND-2, SHELL-7).
    expect(bridge.host.view.snapAll).toBe(true);

    // Стёртая ветвь, доехавшая повтором: номер тика больше, эпоха старше —
    // гасится. Дедуп по одному номеру тика вернул бы рендер в стёртое будущее.
    bridge.apply(match.beforeRewind, 0, false);
    expect(bridge.host.view.tick).toBe(REWIND_TO);
  });

  it('матч без перемотки даёт один сегмент, и прогон сегментов совпадает с прогоном сценария', async () => {
    const config = duelConfig();
    const match = await playMatch(16, { a: walkRight(12) }, config);
    const segments = match.server.canonicalSegments;

    // Сегментация обобщает форму лога, а не отменяет её (NTR-16): у матча без
    // перемотки сегмент один и совпадает с прежним плоским списком.
    expect(segments).toHaveLength(1);
    expect(segments[0]!.epoch).toBe(0);
    expect(segments[0]!.frames).toEqual(match.server.canonicalInputs);

    const canonical = snapshotToPlain(match.server.snapshot());
    expect(snapshotToPlain(replayOf(config, segments).snapshot)).toEqual(canonical);
    // И прежний путь — документ сценария через ядро — остаётся определённым и
    // парным (NTR-8): именно поэтому записанные матчи не двигаются.
    const scenario = runScenario(match.server.toScenario());
    expect(scenario.ticks[scenario.ticks.length - 1]).toEqual(canonical);
  });
});

// --------------------------------------------------- ульта отката в вертикали

/**
 * Бит ульты в `buttons` — раскладка сборки игры. В вертикали он живёт трижды:
 * его ловит фронтом JSON-система сцены, его же читает сервер во время
 * `Rewinding` (конфиг матча), и он же приезжает обычным кадром ввода — второго
 * канала под управление в протоколе нет (NTR-8).
 */
const ULT_BUTTON = 7;
const ULT = 1 << ULT_BUTTON;
/**
 * Обычное действие рядом с ультой: им проверяется, что ввод, порождённый в
 * замороженном мире, на симуляцию после возобновления не влияет (NET-11,
 * REW-5). Бит выбран свободный — сцена его ни во что не превращает, и видно
 * его в компоненте `Input` героя.
 */
const CAST_BUTTON = 3;
const CAST = 1 << CAST_BUTTON;
/** Глубина автостопа из payload запроса и шаг ведения точки — числа этой сцены. */
const ULT_DEPTH_TICKS = 40;
const SCRUB_STEP = 4;
/** Интервал снапшотов интерактивного скраба (SNAP-4): реплей — до 30 тиков на шаг. */
const SCRUB_INTERVAL = 30;
const ULT_COOLDOWN = 600;

const ulted = { var: 'e' } as const;
const ultField = (component: string, name: string): object => ({
  getComponent: [ulted, component, name],
});

/**
 * Сцена вертикали плюс ульта отката — та же форма, что в демо-сцене: cooldown в
 * собственном компоненте, гейт по фронту кнопки и по нулю cooldown'а, эмиссия
 * события-запроса с глубиной. Ни одного балансного числа за пределами сцены.
 */
function ultScene(): SceneDef {
  const scene = duelScene();
  const hero = scene.prefabs![0]!;
  return {
    ...scene,
    components: [
      ...scene.components,
      { name: 'RewindCooldown', fields: { max: 'i32', ticks: 'i32' } },
    ],
    prefabs: [
      {
        ...hero,
        components: { ...hero.components, RewindCooldown: { max: ULT_COOLDOWN, ticks: 0 } },
      },
    ],
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'RewindCooldownTick',
        order: 5,
        query: { all: ['RewindCooldown'] },
        as: 'e',
        do: [
          {
            if: {
              cond: { '>': [ultField('RewindCooldown', 'ticks'), 0] },
              then: [
                {
                  modifyComponent: {
                    entity: ulted,
                    component: 'RewindCooldown',
                    values: { ticks: { '-': [ultField('RewindCooldown', 'ticks'), 1] } },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        name: 'RewindCast',
        order: 40,
        query: { all: ['Input', 'Player', 'RewindCooldown'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [ultField('Input', 'buttons'), ULT_BUTTON] },
                  { '!': [{ bitTest: [ultField('Input', 'prevButtons'), ULT_BUTTON] }] },
                  { '==': [ultField('RewindCooldown', 'ticks'), 0] },
                ],
              },
              then: [
                {
                  modifyComponent: {
                    entity: ulted,
                    component: 'RewindCooldown',
                    values: { ticks: ultField('RewindCooldown', 'max') },
                  },
                },
                {
                  emitEvent: {
                    type: REWIND_REQUEST_EVENT,
                    data: { depthTicks: ULT_DEPTH_TICKS, initiator: ulted },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function ultConfig(exempt: boolean) {
  return duelConfig({
    scene: ultScene(),
    rewind: {
      interval: SCRUB_INTERVAL,
      capacity: 15,
      holdButton: ULT_BUTTON,
      step: SCRUB_STEP,
      holdTimeoutTicks: 15,
      ...(exempt ? { exempt: [{ component: 'RewindCooldown' }] } : {}),
    },
  });
}

/** Значение поля первой сущности, у которой оно есть, — герой матча здесь один такой. */
function fieldOfSlot(snapshot: PresentedState, slot: number, component: string, field: string): number {
  for (const entity of query(snapshot.world, { all: ['Player', component] })) {
    if (coreWorld.getField(snapshot.world, entity, 'Player', 'slot') !== slot) continue;
    return coreWorld.getField(snapshot.world, entity, component, field);
  }
  throw new Error(`слот ${slot} без компонента ${component}`);
}

/**
 * Матч с настоящей ультой: кнопка едет обычным кадром ввода, JSON-система сцены
 * ловит фронт и эмитит запрос, сервер дренирует его после тика и ведёт точку
 * перемотки, пока кнопка удержана.
 */
async function playUltMatch(options: { exempt: boolean; holdSteps: number; lag?: boolean }) {
  const config = ultConfig(options.exempt);
  const fixture = harness(config);
  const scene = config.scene;
  let hold = false;
  const a = connectClient(
    fixture.hub,
    'p1',
    fixture.clock,
    scene,
    () => ({
      move: { x: hold ? 0 : STEP, y: 0 },
      aimDir: 0,
      // Игрок жмёт ульту и ДЕРЖИТ её, продолжая двигаться и кастовать: ровно
      // то, что делают руки, пока мир заморожен. Наружу из этого уедет только
      // бит ведения скраба — маска замороженного мира (NET-11, REW-5).
      buttons: hold ? ULT | CAST : 0,
    }),
    { holdButton: ULT_BUTTON },
  );
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene);
  const bridge = new RenderBridge(scene, config, fixture.clock);
  await settle();

  /** Что доехало до рендера: по записи видно и режим, и snap каждой доставки. */
  const rendered: { tick: number; mode: string; snapAll: boolean }[] = [];
  const deliver = (): void => {
    const discontinuity = b.client.takeDiscontinuity();
    const latest = b.client.latest;
    if (latest === undefined) return;
    bridge.apply(latest, b.client.epoch, discontinuity);
    rendered.push({
      tick: bridge.host.view.tick,
      mode: bridge.host.view.mode,
      snapAll: bridge.host.view.snapAll,
    });
  };

  /**
   * Круг матча. `lag` переставляет шаг сервера ПЕРЕД шагом клиентов: кадр,
   * отправленный на этом шаге, ингестится только на следующем — плечо канала
   * длиной в шаг.
   *
   * Без плеча дыра NET-11 не воспроизводится вовсе: кадр, порождённый в
   * замороженном мире, обязан доехать ПОСЛЕ возобновления, а на канале нулевой
   * длины он всегда успевает до него.
   */
  const tick = async (lag = false): Promise<void> => {
    fixture.clock.ms += 1000 / TICK_RATE;
    if (lag) {
      fixture.host.step();
      await settle();
      a.host.step();
      b.host.step();
    } else {
      a.host.step();
      b.host.step();
      await settle();
      fixture.host.step();
    }
    await settle();
    deliver();
  };

  // Прогрев: живая ветвь длиннее глубины отката — иначе автостоп упёрся бы в
  // историю, а не в число из запроса.
  for (let i = 0; i < 80; i++) await tick();
  const beforeCast = fixture.server.snapshot();

  hold = true;
  for (let i = 0; i < 20 && fixture.server.mode === 'Running'; i++) await tick();
  const castTick = fixture.server.tick;
  expect(fixture.server.mode).toBe('Rewinding');

  /** Точки остановки по шагам скраба — по ним видно и шаг, и монотонность. */
  const points: number[] = [];
  for (let i = 0; i < options.holdSteps; i++) {
    await tick();
    points.push(fixture.server.tick);
  }

  hold = false;
  // Плечо канала включается только там, где оно предмет проверки: с ним
  // отпускание доезжает на шаг позже, и скраб успевает сделать лишний шаг —
  // честное поведение канала с плечом, но шаг ведения оно измерять мешает.
  const lag = options.lag ?? false;
  for (let i = 0; i < 20 && fixture.server.mode !== 'Running'; i++) await tick(lag);
  const resumedAt = fixture.server.tick;
  /** Ввод, применённый первыми живыми тиками возобновлённого мира. */
  const afterResume: number[] = [];
  for (let i = 0; i < 10; i++) {
    await tick(lag);
    afterResume.push(fieldOfSlot(fixture.server.snapshot(), 0, 'Input', 'buttons'));
  }

  return {
    ...fixture,
    a,
    b,
    bridge,
    config,
    castTick,
    points,
    resumedAt,
    beforeCast,
    rendered,
    afterResume,
    hold: () => hold,
  };
}

describe('ульта отката в вертикали: контент решает, хост исполняет (WSM-5, NET-11)', () => {
  it('запрос из JSON-системы замораживает мир, удержание ведёт точку, отпускание возобновляет', async () => {
    const match = await playUltMatch({ exempt: true, holdSteps: 3 });

    // Шаг ведения — из конфига матча, монотонно назад.
    expect(match.points).toEqual([
      match.castTick - SCRUB_STEP,
      match.castTick - 2 * SCRUB_STEP,
      match.castTick - 3 * SCRUB_STEP,
    ]);
    // Отпускание вернуло мир в `Running` с ДОСТИГНУТОЙ точки, а не с ещё одной
    // назад: исчезновение бита в свежем кадре инициатора кончает скраб, шага
    // при этом не делая.
    expect(match.resumedAt).toBe(match.points[match.points.length - 1]);
    expect(match.server.mode).toBe('Running');
    expect(match.server.tick).toBe(match.resumedAt + 10);
    // Перемотка наблюдаема сменой эпохи (NTR-16), и клиент её увидел.
    expect(match.server.epoch).toBeGreaterThan(0);
    expect(match.b.client.epoch).toBe(match.server.epoch);
  });

  it('скраб доезжает до рендера непрерывным ходом: snap только на входе и выходе', async () => {
    const match = await playUltMatch({ exempt: true, holdSteps: 3 });
    const scrub = match.rendered.filter((view) => view.mode === 'Rewinding');

    // Скраб дошёл до рендера целиком: по доставке на каждый шаг ведения точки.
    expect(scrub.length).toBeGreaterThanOrEqual(3);
    // Вход в перемотку — разрыв: между живым тиком и историческим состоянием
    // промежуточных положений не было (REND-2, SHELL-7).
    expect(scrub[0]!.snapAll).toBe(true);
    // А дальше — обычная интерполяция, хотя эпоха растёт на КАЖДОМ
    // восстановлении (NTR-16). Иначе весь обратный ход рисовался бы чередой
    // телепортов — ровно то, что дельта REND-2 запрещает.
    expect(scrub.slice(1).map((view) => view.snapAll)).toEqual(scrub.slice(1).map(() => false));
    // Номера тиков при этом идут назад — то есть интерполируется именно скраб.
    expect(scrub[1]!.tick).toBeLessThan(scrub[0]!.tick);
    // Выход из перемотки — снова разрыв: смену режима рисует snap.
    const exit = match.rendered.findIndex(
      (view, at) => at > 0 && view.mode !== 'Rewinding' && match.rendered[at - 1]!.mode === 'Rewinding',
    );
    expect(exit).toBeGreaterThan(0);
    expect(match.rendered[exit]!.snapAll).toBe(true);
  });

  it('ввод замороженного мира на возобновлённую симуляцию не влияет (NET-11, REW-5)', async () => {
    // Игрок всё время удержания жал и обычное действие рядом с ультой, а кадры
    // последних шагов доехали уже ПОСЛЕ возобновления (плечо канала в шаг):
    // эпоха у них верная, тик — будущий, и сервер их принимает. До мира они всё
    // равно не доходят — клиент шлёт из замороженного мира только бит ведения
    // скраба, а `move` обнуляет.
    const match = await playUltMatch({ exempt: true, holdSteps: 3, lag: true });

    expect(match.afterResume.length).toBeGreaterThan(0);
    for (const buttons of match.afterResume) expect(buttons & CAST).toBe(0);
    // Мир при этом идёт: возобновление состоялось.
    expect(match.server.mode).toBe('Running');
  });

  it('cooldown ульты переживает откат, а вторая ульта отсекается гейтом контента', async () => {
    const match = await playUltMatch({ exempt: true, holdSteps: 2 });
    const afterRewind = match.server.snapshot();

    // Ульта прожата на тике `castTick`, мир откачен на два десятка тиков назад —
    // и всё же cooldown стоит взведённым: exempt-компонент отката не пережил бы
    // только вместе с сущностью.
    expect(fieldOfSlot(afterRewind, 0, 'RewindCooldown', 'ticks')).toBeGreaterThan(0);
    expect(fieldOfSlot(match.beforeCast, 0, 'RewindCooldown', 'ticks')).toBe(0);

    // Кнопка нажата заново в возобновлённом мире: гейт системы вторую перемотку
    // не пускает, и мир остаётся в `Running`.
    const epochBefore = match.server.epoch;
    const tickBefore = match.server.tick;
    for (let i = 0; i < 12; i++) {
      match.clock.ms += 1000 / TICK_RATE;
      match.a.host.step();
      match.host.step();
    }
    expect(match.server.mode).toBe('Running');
    expect(match.server.epoch).toBe(epochBefore);
    expect(match.server.tick).toBeGreaterThan(tickBefore);
  });

  it('сегментированный лог матча с ультой прогоняется побитово (NTR-8)', async () => {
    // Без exempt-списка: канонический лог — это ВВОД, и значения, которые
    // перемотка сохранила из стёртой ветви, из него не выводятся. Пара
    // «запись — прогон» определена ровно для мира, целиком выведенного из
    // ввода, поэтому механизм проверяется на матче без исключений отката.
    const match = await playUltMatch({ exempt: false, holdSteps: 3 });
    const segments = match.server.canonicalSegments;

    expect(segments.length).toBeGreaterThan(1);
    const replay = replayOf(match.config, segments);
    expect(replay.tick).toBe(match.server.tick);
    expect(snapshotToPlain(replay.snapshot)).toEqual(snapshotToPlain(match.server.snapshot()));
  });

  it('exempt-значение — единственное расхождение записи и прогона', async () => {
    const match = await playUltMatch({ exempt: true, holdSteps: 3 });
    const replayed = snapshotToPlain(replayOf(match.config, match.server.canonicalSegments).snapshot);
    const canonical = snapshotToPlain(match.server.snapshot());

    // Cooldown, сохранённый через откат, в прогоне лога не воспроизводится: он
    // пришёл из стёртой ветви, а лог несёт только ввод. Это цена exempt-списка
    // (REW-9), и она названа здесь, а не обнаруживается в отладке чужого матча.
    expect(replayed.world.components.RewindCooldown).not.toEqual(
      canonical.world.components.RewindCooldown,
    );
    // Всё остальное совпадает побитово — включая rng, шину и режим мира.
    const strip = (plain: typeof canonical): unknown => ({
      ...plain,
      world: {
        ...plain.world,
        components: Object.fromEntries(
          Object.entries(plain.world.components).filter(([name]) => name !== 'RewindCooldown'),
        ),
      },
    });
    expect(strip(replayed)).toEqual(strip(canonical));
  });
});
