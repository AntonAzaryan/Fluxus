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
  type Snapshot,
} from '@game-mvp/core';
import { replaySegments, type InputSource, type MatchSegment } from '@game-mvp/net';
import {
  RenderBridge,
  STEP,
  TICK_RATE,
  connectClient,
  duelConfig,
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
function slotX(snapshot: Snapshot, slot: number): number {
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
