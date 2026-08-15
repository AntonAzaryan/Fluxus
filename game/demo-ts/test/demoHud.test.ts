/**
 * Композиция HUD демо как ДАННЫЕ (HUD-4) и путь статов до неё (HUD-8).
 *
 * Первое — резолв композиции против тех же реестров, которыми её резолвит
 * `apply`: неизвестный виджет, селектор или действие обязаны падать здесь, а не
 * на живой странице. Второе — headless-прогон сборки демо: конфигурация
 * экстрактора → канал → доставленное состояние главного потока; проверяется,
 * что статы и фаза полёта доезжают до `TickView`, из которого HUD и читает.
 */
import { describe, expect, it } from 'vitest';
import { tick as simTick, type SceneDef } from '@game-mvp/core';
import { resolveComposition, type MinimapTerrainSource } from '@game-mvp/hud';
import type { AssetService, VisualManifest } from '@game-mvp/assets';
import { RemoteHost, WorkerShell } from '@game-mvp/client';
import { createDemoHudRegistry, demoHudComposition } from '../app/hud.js';
import { createDemoExtractor } from '../app/extractor.js';
import {
  ACTION_BITS,
  COOLDOWN_ABILITIES,
  PLAYER_ID,
  STATS,
  TICK_SECONDS,
  chargeHeld,
  chargeVisualOf,
  createDemoSimulation,
} from '../app/sim.js';
import { dummyContext, syncPortPair } from './fixtures.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const SCENE = sceneJson as unknown as SceneDef;
const CAST = 1 << ACTION_BITS.cast;

/** Заглушки швов сборки: реестрам они нужны только чтобы виды создались. */
const stubOptions = {
  assets: {} as unknown as AssetService,
  visuals: { entities: {} } as VisualManifest,
  terrain: { terrain: null } as MinimapTerrainSource,
};

describe('композиция HUD демо резолвится против реестров (HUD-4)', () => {
  it.each([true, false])('сборка с controls=%s: все имена известны', (controls) => {
    const registry = createDemoHudRegistry(stubOptions);
    const composition = demoHudComposition({ controls, tickMs: TICK_SECONDS * 1000 });
    const resolved = resolveComposition(registry, composition);
    expect(resolved.entries).toHaveLength(composition.entries.length);
    // Виджеты на месте — включая те, что появились вместе со статами (HUD-8).
    expect(resolved.entries.map((entry) => entry.kind.name)).toEqual(
      expect.arrayContaining(['runtime', 'deaths', 'cooldowns', 'hp-bar', 'minimap', 'portrait']),
    );
  });

  it('панель кулдаунов забиндена на имена статов сборки, а не на компоненты мира', () => {
    const composition = demoHudComposition({ controls: true, tickMs: 16 });
    const cooldowns = composition.entries.find((entry) => entry.widget === 'cooldowns')!;
    const abilities = cooldowns.params!.abilities as readonly Record<string, string>[];
    expect(abilities.map((ability) => ability.action)).toEqual([...COOLDOWN_ABILITIES]);
    expect(abilities[0]!.stat).toBe(STATS.cooldown('cast'));
    expect(abilities[0]!.maxStat).toBe(STATS.cooldownMax('cast'));
    // Имён компонентов мира в композиции нет: она о них не знает (HUD-8).
    expect(JSON.stringify(composition)).not.toContain('Cooldowns');
  });

  it('портрет воскресает по событию, которое сцена ДЕЙСТВИТЕЛЬНО эмитит', () => {
    // Зеркало имени: возрождение демо не пересоздаёт сущность (тот же
    // `EntityId` снимает `Dead`), поэтому «портрет ожил» держится ровно на
    // совпадении этой строки с типом события системы `Respawn`. Опечатка здесь
    // выглядела бы как мёртвый портрет на живом герое — и молчала бы.
    const composition = demoHudComposition({ controls: true, tickMs: 16 });
    const portrait = composition.entries.find((entry) => entry.widget === 'portrait')!;
    const reviveEvent = portrait.params!.reviveEvent as string;
    const respawn = SCENE.systems!.find((system) => system.name === 'Respawn')!;
    expect(JSON.stringify(respawn.do)).toContain(`"type":"${reviveEvent}"`);
  });

  it('виды виджетов создаются по своим params: ошибка параметра — до монтирования', () => {
    const registry = createDemoHudRegistry(stubOptions);
    const composition = demoHudComposition({ controls: true, tickMs: 16 });
    for (const entry of resolveComposition(registry, composition).entries) {
      // Портрет тянет THREE-стенд и заглушечный asset-сервис — его пропускаем:
      // проверяется резолв параметров остальных, а не рендер портрета (HUD-7).
      if (entry.kind.name === 'portrait') continue;
      expect(() => entry.kind.create(entry.params)).not.toThrow();
    }
  });
});

describe('headless-прогон демо: статы и фаза полёта доезжают (HUD-8, REND-12)', () => {
  it('слот игрока приезжает статом, снаряд — фазой полёта', () => {
    const { sim, state, playerId, grid } = createDemoSimulation(SCENE);
    const [workerPort, mainPort] = syncPortPair();
    const shell = new WorkerShell({
      mode: 'local',
      port: workerPort,
      sim,
      state,
      tickSeconds: TICK_SECONDS,
      extractor: createDemoExtractor(grid),
      playerId: PLAYER_ID,
      helloExtra: { hero: playerId },
      clock: () => 0,
    });

    let names: readonly string[] | undefined;
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: (hello) => {
        names = hello.statNames;
      },
    }).connect(mainPort);
    shell.start();
    // Словарь статов сборки уехал один раз, handshake'ом (SHELL-5).
    expect(names).toContain(STATS.slot);
    expect(names).toContain(STATS.hp);

    // Каст: нажатие копит заряд, отпускание стреляет — снаряд рождается и
    // летит, а сборка считает ему фазу полёта.
    simTick(sim, state, [
      { tick: state.tick + 1, playerId: PLAYER_ID, seq: 1, move: { x: 0, y: 0 }, aimDir: 0, buttons: 1 },
    ]);
    simTick(sim, state, [
      { tick: state.tick + 1, playerId: PLAYER_ID, seq: 2, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 },
    ]);
    for (let i = 0; i < 6; i++) shell.stepTick();

    const view = remote.view!;
    expect(view.statNames).toContain(STATS.slot);
    const hero = view.entities.get(playerId)!;
    // Слот игрока есть — компонент в сцене живой.
    expect(hero.stats!.get(STATS.slot)).toBe(0);
    // Здоровье приехало вместе с геймплейной фазой: компонент `Health` у героя
    // сцены есть, и стат доезжает значением, а не отсутствием.
    expect(hero.stats!.get(STATS.hp)).toBe(1000);
    expect(hero.stats!.get(STATS.hpMax)).toBe(1000);
    // А счёта в сцене по-прежнему нет: стат объявлен, но не доехал — «нет
    // данных», ровно тот сценарий пустого состояния, который описывает HUD-8.
    expect(hero.stats!.has(STATS.deaths)).toBe(false);

    const fireball = [...view.entities.values()].find((entity) => entity.kind === 'Fireball');
    expect(fireball).toBeDefined();
    // Фаза полёта считается воркером из `Lifetime` и растёт по ходу полёта.
    expect(fireball!.flightPhase).toBeGreaterThan(0);
    expect(fireball!.flightPhase).toBeLessThan(1);
    // У героя фазы полёта нет — он не летит (REND-12).
    expect(Number.isNaN(hero.flightPhase)).toBe(true);
  });

  /**
   * Путь стата `charge` целиком: `Charging.ticks` симуляции → экстрактор →
   * канал → `EntityView.stats` главного потока, который и растит по нему шар
   * заряда. Без этого теста дыра в любом звене выглядела бы как «шара нет» —
   * и молчала бы ровно так же, как честное «не заряжаю» (HUD-8).
   */
  it('заряд каста доезжает статом и ПРОПАДАЕТ на отпускании', () => {
    const { sim, state, playerId, grid } = createDemoSimulation(SCENE);
    const [workerPort, mainPort] = syncPortPair();
    const shell = new WorkerShell({
      mode: 'local',
      port: workerPort,
      sim,
      state,
      tickSeconds: TICK_SECONDS,
      extractor: createDemoExtractor(grid),
      playerId: PLAYER_ID,
      helloExtra: { hero: playerId },
      clock: () => 0,
    });
    const remote = new RemoteHost(dummyContext(), { clock: () => 0, onReady: () => {} }).connect(
      mainPort,
    );
    shell.start();

    // Кнопка держится КАЖДЫЙ тик: латч оболочки чистится после тика (INP-2).
    const HELD = 12;
    for (let i = 0; i < HELD; i++) {
      remote.sendInput({ x: 0, y: 0 }, 0, CAST);
      shell.stepTick();
    }
    const charging = remote.view!.entities.get(playerId)!;
    // Тик НАЖАТИЯ только заводит `Charging{ticks: 0}` — счёт идёт со следующего.
    expect(charging.stats!.get(STATS.charge)).toBe(HELD - 1);
    // И ровно столько же насчитает шар заряда главного потока.
    expect(chargeHeld(charging.stats!.get(STATS.charge)!, chargeVisualOf(SCENE).ticks)).toBe(
      HELD - 2,
    );

    // Отпускание: заряд израсходован, и стата НЕТ — «не заряжаю», а не ноль.
    shell.stepTick();
    expect(remote.view!.entities.get(playerId)!.stats!.has(STATS.charge)).toBe(false);
  });
});

describe('числа шара заряда читаются из сцены (`sim.ts`)', () => {
  it('`chargeHeld` вычитает тик нажатия и упирается в окно роста', () => {
    const { ticks: max, graceTicks } = chargeVisualOf(SCENE);
    // Ни одного тика удержания — обычный шар, а не «чуть заряженный».
    expect(chargeHeld(0, max)).toBe(0);
    expect(chargeHeld(1, max)).toBe(0);
    expect(chargeHeld(2, max)).toBe(1);
    // Полный заряд набирается на 61-м тике удержания: тик нажатия не в счёт.
    expect(chargeHeld(max + 1, max)).toBe(max);
    // Дальше окно роста НЕ растёт — тики передержки видны только в сыром
    // `Charging.ticks`, и предел здесь тот же, что у `ChargeRelease` в сцене.
    expect(chargeHeld(max + graceTicks + 1, max)).toBe(max);
  });

  it('`chargeVisualOf` падает громко, если поля `AbilityConfig` нет', () => {
    const hero = SCENE.prefabs!.find((prefab) => prefab.name === 'Hero')!;
    const { chargeMaxScale: _dropped, ...rest } = hero.components.AbilityConfig!;
    const holed: SceneDef = {
      ...SCENE,
      prefabs: SCENE.prefabs!.map((prefab) =>
        prefab.name === 'Hero'
          ? { ...prefab, components: { ...prefab.components, AbilityConfig: rest } }
          : prefab,
      ),
    };
    // Дыра в контенте обязана СООБЩИТЬ о себе: молчаливый ноль дал бы шар
    // нулевого размера, то есть «способности нет» вместо «поля нет».
    expect(() => chargeVisualOf(holed)).toThrow(/chargeMaxScale/);
  });
});
