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
import { RemoteHost, WorkerShell } from '../src/index.js';
import { createDemoHudRegistry, demoHudComposition } from '../demo/hud.js';
import { createDemoExtractor } from '../demo/extractor.js';
import { COOLDOWN_ABILITIES, PLAYER_ID, STATS, TICK_SECONDS, createDemoSimulation } from '../demo/sim.js';
import { dummyContext, syncPortPair } from './fixtures.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const SCENE = sceneJson as unknown as SceneDef;

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
});
