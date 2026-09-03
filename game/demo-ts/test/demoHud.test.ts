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
import {
  FIXED_ONE,
  tick as simTick,
  world as coreWorld,
  type SceneDef,
} from '@fluxus/core';
import { resolveComposition, type MinimapTerrainSource } from '@fluxus/hud';
import { AssetService, type VisualManifest } from '@fluxus/assets';
import { RemoteHost, WorkerShell } from '@fluxus/client';
import { createDemoHudRegistry, demoHudComposition } from '../app/hud.js';
import demoBindings from '../app/bindings.json';
import { createDemoExtractor } from '../app/extractor.js';
import {
  ACTION_BITS,
  COOLDOWN_ABILITIES,
  PLAYER_ID,
  STATS,
  TICK_SECONDS,
  createDemoSimulation,
  stateBit,
} from '../app/sim.js';
import { DEMO_REWIND } from '../app/match.js';
import { dummyContext, syncPortPair } from './fixtures.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const SCENE = sceneJson as unknown as SceneDef;
const CAST = 1 << ACTION_BITS.cast;

/**
 * Заглушки швов сборки: реестрам они нужны только чтобы виды создались.
 * `assets` — НАСТОЯЩИЙ сервис поверх пустого источника: иконки панели живут тем
 * же слоем ассетов, что модели (HUD-4), и подделывать его нечем.
 */
const stubOptions = {
  assets: new AssetService({ read: () => Promise.reject(new Error('дерева контента нет')) }),
  visuals: { entities: {} } as VisualManifest,
  terrain: { terrain: null } as MinimapTerrainSource,
};

describe('композиция HUD демо резолвится против реестров (HUD-4)', () => {
  // Две сборки демо: локальная (своя машина состояний, `controls`) и сетевая
  // (пауза матча сервером, `matchPause`, NTR-20). Резолв обязан сойтись у обеих.
  it.each([true, false])('сборка с controls=%s: все имена известны', (controls) => {
    const registry = createDemoHudRegistry(stubOptions);
    const composition = demoHudComposition({
      controls,
      matchPause: !controls,
      tickMs: TICK_SECONDS * 1000,
    });
    const resolved = resolveComposition(registry, composition);
    expect(resolved.entries).toHaveLength(composition.entries.length);
    // Виджеты на месте — включая те, что появились вместе со статами (HUD-8).
    expect(resolved.entries.map((entry) => entry.kind.name)).toEqual(
      expect.arrayContaining(['runtime', 'deaths', 'cooldowns', 'hp-bar', 'minimap', 'portrait']),
    );
  });

  /**
   * Полоса здоровья героя стоит НАД НИМ по мировому якорю (HUD-10): место ей
   * даёт проекция, которую публикует рендер (`rendering` REND-41), а объявлено
   * это ЗАПИСЬЮ композиции — кода виджета размещение не касается (HUD-4).
   */
  it('полоса здоровья размещена по мировому якорю героя (HUD-10)', () => {
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
    const hp = composition.entries.find((entry) => entry.widget === 'hp-bar')!;
    expect(hp.anchor).toBeDefined();
    // Сущность названа СЛОТОМ биндинга, а не идентификатором: композиция —
    // значение со ссылками-именами (HUD-4).
    expect(hp.anchor!.entity).toBe('entity');
    expect(hp.bindings![hp.anchor!.entity]).toBe('hero.entity');
    // И резолв это подтверждает: слот якоря обязан быть среди биндингов записи.
    const resolved = resolveComposition(createDemoHudRegistry(stubOptions), composition);
    const entry = resolved.entries.find((one) => one.kind.name === 'hp-bar')!;
    expect(entry.anchor).toEqual(hp.anchor);
  });

  it('панель кулдаунов забиндена на имена статов сборки, а не на компоненты мира', () => {
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
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
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
    const portrait = composition.entries.find((entry) => entry.widget === 'portrait')!;
    const reviveEvent = portrait.params!.reviveEvent as string;
    const respawn = SCENE.systems!.find((system) => system.name === 'Respawn')!;
    expect(JSON.stringify(respawn.do)).toContain(`"type":"${reviveEvent}"`);
  });

  it('виды виджетов создаются по своим params: ошибка параметра — до монтирования', () => {
    const registry = createDemoHudRegistry(stubOptions);
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
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

    // Каст: нажатие копит заряд, отпускание открывает прицеливание, а
    // подтверждение выпускает снаряд (ABIL-4, ABIL-5) — он рождается и летит, а
    // сборка считает ему фазу полёта.
    const press = (seq: number, buttons: number): void => {
      simTick(sim, state, [
        {
          tick: state.tick + 1,
          playerId: PLAYER_ID,
          seq,
          move: { x: 0, y: 0 },
          aimDir: 0,
          buttons,
        },
      ]);
    };
    press(1, 1 << ACTION_BITS.cast);
    press(2, 0);
    press(3, 1 << ACTION_BITS.confirm);
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
    // Фаза полёта считается воркером из остатка доставки и растёт по ходу полёта.
    expect(fireball!.flightPhase).toBeGreaterThan(0);
    expect(fireball!.flightPhase).toBeLessThan(1);
    // У героя фазы полёта нет — он не летит (REND-12).
    expect(Number.isNaN(hero.flightPhase)).toBe(true);
  });

  /**
   * Радиус обзора доезжает ЭФФЕКТИВНЫМ (change `fog-observer-inputs`, FOW-3):
   * стат указывает на опубликованное состояние `VisionState`, а не на авторский
   * `Vision.radius`. Разница наблюдаема только под модификатором обзора, но
   * пинить нужно ИСТОЧНИК: маска тумана строит по этой величине круг, и
   * расхождение с симуляцией в большую сторону FOW-9 запрещает прямо.
   */
  it('радиус обзора доезжает из VisionState — величины симуляции, а не авторской', () => {
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
    for (let i = 0; i < 4; i++) shell.stepTick();

    const hero = remote.view!.entities.get(playerId)!;
    const delivered = hero.stats!.get(STATS.visionRadius);
    expect(delivered).toBeDefined();
    // Ровно то, что опубликовал пересчёт видимости, приведённое к мировым
    // единицам на границе потока тиков (REND-1).
    const published =
      coreWorld.getField(state.world, playerId, 'VisionState', 'radius') / FIXED_ONE;
    expect(published).toBeGreaterThan(0);
    expect(delivered).toBeCloseTo(published, 6);
    // Команда рядом с ним — второй вход маски (design D4 тумана).
    expect(hero.stats!.get(STATS.team)).toBeDefined();
  });

  /**
   * Путь состояния слота каста целиком: поля `AbilitySlot` симуляции →
   * экстрактор (слотовая форма источника, ABIL-1) → канал → `EntityView.stats`
   * главного потока, откуда их читает превью каста (REND-28). Без этого теста
   * дыра в любом звене выглядела бы как «превью нет» — и молчала бы ровно так
   * же, как честное «каста нет» (HUD-8).
   */
  it('фаза каста доезжает статом слота и ПРОПАДАЕТ на выстреле', () => {
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
    // Фаза заряда — нулевая в списке фаз определения, а её счётчик считает
    // тики удержания: тик нажатия только входит в фазу.
    expect(charging.stats!.get(STATS.slotPhase('cast'))).toBe(0);
    expect(charging.stats!.get(STATS.slotStaged('cast'))).toBe(0);
    expect(charging.stats!.get(STATS.slotAbility('cast'))).toBe(0);
    // И маркер сцены доехал битом состояния — по нему рисуется шар заряда.
    expect(charging.states & stateBit('Charging')).toBe(stateBit('Charging'));

    // Отпускание — выстрел (фаза `release`), и фаза становится «каста нет»
    // (−1), а не пропадает: слот жив всегда. Превью гаснет по той же величине,
    // и статы обязаны доехать до него одним кадром с выстрелом.
    remote.sendInput({ x: 0, y: 0 }, 0, 0);
    shell.stepTick();
    const done = remote.view!.entities.get(playerId)!;
    expect(done.stats!.get(STATS.slotPhase('cast'))).toBe(-1);
    // Кулдаун при этом поехал тем же слотовым источником.
    expect(done.stats!.get(STATS.cooldown('cast'))).toBeGreaterThan(0);
    expect(done.stats!.get(STATS.cooldownMax('cast'))).toBe(60);
  });
});

/**
 * Кнопка ульты в панели способностей: она показывает кулдаун И кастуется —
 * формой «удержание» (HUD-2). Скраб перемотки живёт на удержании органа
 * управления, и с появлением этой формы у контракта действий HUD кнопка
 * перестала быть заглушкой: выключенной кнопки с подсказкой «только клавишей»
 * на её месте больше нет.
 */
describe('панель способностей не обещает нажатий, которых не выполнит (HUD-2)', () => {
  /** Запись панели по имени способности — из значения композиции. */
  function abilityRecord(action: string): Record<string, unknown> {
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
    const cooldowns = composition.entries.find((entry) => entry.widget === 'cooldowns')!;
    const abilities = cooldowns.params!.abilities as readonly Record<string, unknown>[];
    return abilities.find((ability) => ability.action === action)!;
  }

  it('ульта отката объявлена формой «удержание» и обычным мировым действием', () => {
    const rewind = abilityRecord('rewind');
    // Форма — данные композиции (HUD-2): виджет о смысле способности не знает.
    expect(rewind.hold).toBe(true);
    // Действие — мировое, то есть тот же ввод, что от назначенной клавиши;
    // presentation-заглушки `() => undefined` на его месте больше нет.
    const registry = createDemoHudRegistry(stubOptions);
    expect(registry.action('hero.rewind')).toEqual({ target: 'world', action: 'rewind' });
  });

  it('удерживаемых способностей ровно одна, остальные — фронт', () => {
    for (const action of COOLDOWN_ABILITIES) {
      expect(abilityRecord(action).hold).toBe(action === 'rewind');
    }
  });

  it('помеченная удержанием способность всё равно показывает свой кулдаун', () => {
    // Форма органа управления не отменяет оверлея: игрок обязан видеть, сколько
    // ждать.
    const rewind = abilityRecord('rewind');
    expect(rewind.stat).toBe(STATS.cooldown('rewind'));
    expect(rewind.maxStat).toBe(STATS.cooldownMax('rewind'));
    const composition = demoHudComposition({ controls: true, matchPause: true, tickMs: 16 });
    const cooldowns = composition.entries.find((entry) => entry.widget === 'cooldowns')!;
    expect(cooldowns.actions!.rewind).toBeDefined();
  });

  it('кнопка и клавиша ульты ссылаются на одно действие, а его бит — на бит матча', () => {
    // Второго словаря «действие → бит» сборка не заводит: кнопка панели и
    // клавиша раскладки называют одно семантическое имя (INP-4), а бит у имени
    // один. Проверяется СВЯЗЬ, а не число: номер бита выводится из раскладки
    // `ACTION_BITS`, и прибивать его константой значило бы ловить не расхождение,
    // а любую перестановку списка.
    const keys = demoBindings.keyboardMouse.keys as Readonly<Record<string, string>>;
    expect(Object.values(keys)).toContain('rewind');
    expect(abilityRecord('rewind').action).toBe('rewind');
    // Орган ВЕДЕНИЯ скраба — тот же бит, и его номер называет документ матча
    // (`rewind.holdButton`): разошлись бы — удержание кнопки кастовало ульту, а
    // точку остановки не вело (NET-11, REW-13).
    expect(ACTION_BITS.rewind).toBe(DEMO_REWIND?.holdButton);
  });
});
