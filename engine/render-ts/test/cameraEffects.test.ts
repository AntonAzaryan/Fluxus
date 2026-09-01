/**
 * Слой эффектов камеры (camera CAM-6, assets ASSET-8): стек и офсеты,
 * trauma-стакание, множитель 0, подавление импульсов при реплее, длящиеся
 * эффекты от состояний сущности, неизвестный тип — предупреждение и пропуск,
 * зеркалирование состояний в EntityView.states.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type EntityId,
  type Simulation,
} from '@fluxus/core';
import {
  CAMERA_EFFECTS_DESCRIPTION,
  CameraEffectsDirector,
  DEFAULT_SHAKE,
  EffectStack,
  Extractor,
  SwayEffect,
  TraumaShake,
  ViewBuffer,
  type CameraEffectsCatalog,
  type CameraPose,
  type ImpulseEffect,
  type ImpulseEffectType,
  type LastingEffect,
  type LastingEffectType,
  type PoseOffset,
} from '../src/index.js';
import { makeEntityView, makeTickView } from './fixtures.js';

const LOGICAL: CameraPose = {
  posX: 10,
  posY: 20,
  posZ: 5,
  yaw: Math.PI / 2,
  pitch: 0.8,
  roll: 0,
  fovDeg: 45,
};

const offsetOf = (stack: EffectStack, dt = 1 / 60): PoseOffset => {
  const pose = stack.apply(LOGICAL, dt);
  return {
    dx: pose.posX - LOGICAL.posX,
    dy: pose.posY - LOGICAL.posY,
    dz: pose.posZ - LOGICAL.posZ,
    dyaw: pose.yaw - LOGICAL.yaw,
    dpitch: pose.pitch - LOGICAL.pitch,
    droll: pose.roll - LOGICAL.roll,
    dfovDeg: pose.fovDeg - LOGICAL.fovDeg,
  };
};

const isZero = (o: PoseOffset): boolean =>
  o.dx === 0 && o.dy === 0 && o.dz === 0 && o.dyaw === 0 && o.dpitch === 0 && o.droll === 0 && o.dfovDeg === 0;

describe('EffectStack и эффекты (CAM-6)', () => {
  it('пустой стек: финальная поза равна логической', () => {
    expect(isZero(offsetOf(new EffectStack()))).toBe(true);
  });

  it('тряска трясёт и затухает в точный ноль — вклад завершённого эффекта нулевой', () => {
    const stack = new EffectStack();
    const shake = new TraumaShake({ decay: 2 });
    stack.add(shake);
    shake.trigger(1);
    let shook = false;
    for (let i = 0; i < 30; i++) {
      if (!isZero(offsetOf(stack))) shook = true;
    }
    expect(shook).toBe(true);
    for (let i = 0; i < 300; i++) offsetOf(stack); // trauma выгорает
    expect(isZero(offsetOf(stack))).toBe(true);
  });

  it('trauma стакается: второй импульс усиливает тряску, кламп к 1', () => {
    const shake = new TraumaShake({ decay: 0 });
    const out = (): number => {
      const o: PoseOffset = { dx: 0, dy: 0, dz: 0, dyaw: 0, dpitch: 0, droll: 0, dfovDeg: 0 };
      shake.update(1 / 60, o);
      return Math.hypot(o.dx, o.dy);
    };
    shake.trigger(0.3);
    const single = out();
    shake.trigger(0.3);
    expect(out()).toBeGreaterThan(single); // амплитуда ∝ trauma²
    shake.trigger(100);
    expect(out()).toBeLessThanOrEqual(Math.hypot(0.35, 0.35) + 1e-9); // кламп trauma = 1
  });

  it('множитель 0: финальная поза равна логической при активной тряске', () => {
    const stack = new EffectStack(0);
    const shake = new TraumaShake();
    stack.add(shake);
    shake.trigger(1);
    for (let i = 0; i < 10; i++) expect(isZero(offsetOf(stack))).toBe(true);
  });

  it('обратный ход часов презентации эффекты замораживает, а не накачивает (REND-25)', () => {
    const stack = new EffectStack();
    const shake = new TraumaShake({ decay: 2 });
    stack.add(shake);
    shake.trigger(1);
    const started = offsetOf(stack);
    // Отрицательный шаг вычитал бы отрицательное затухание — тряска росла бы
    // от перемотки. Кадр не-`Running` мира эффект не двигает вовсе.
    for (let i = 0; i < 20; i++) offsetOf(stack, -1 / 60);
    for (let i = 0; i < 20; i++) offsetOf(stack, 0);
    expect(offsetOf(stack, 0)).toEqual(started);
  });

  it('sway активен, пока активен; конверт гасит вклад в ноль после снятия', () => {
    const stack = new EffectStack();
    const sway = new SwayEffect({ fadeSeconds: 0.1 });
    stack.add(sway);
    sway.setActive(true);
    let active = false;
    for (let i = 0; i < 60; i++) {
      if (!isZero(offsetOf(stack))) active = true;
    }
    expect(active).toBe(true);
    sway.setActive(false);
    for (let i = 0; i < 60; i++) offsetOf(stack);
    expect(isZero(offsetOf(stack))).toBe(true);
  });
});

describe('CameraEffectsDirector (CAM-6, ASSET-8)', () => {
  // Координаты события — float в мировых единицах: перевод сделан на входной
  // границе рендера (REND-1), а `TickView` здесь конструируется уже за ней.
  const explosion = (x: number, y: number) => ({ type: 'Boom', tick: 1, data: { x, y } });

  const shakeAmount = (stack: EffectStack): number => {
    const o = offsetOf(stack);
    return Math.hypot(o.dx, o.dy, o.dz);
  };

  it('событие из манифеста запускает тряску; после затухания поза чистая', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1, decay: 5 } } },
    });
    director.onTick(
      makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }),
      0,
      0,
      null,
    );
    expect(shakeAmount(director.stack)).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('сила импульса ослабляется расстоянием до точки наблюдения', () => {
    const tables = {
      events: { Boom: { effect: 'shake', amplitude: 1, radius: 10, decay: 0 } },
    };
    const near = new CameraEffectsDirector({ tables });
    near.onTick(makeTickView([], { freshEvents: true, events: [explosion(1, 0)] }), 0, 0, null);
    const far = new CameraEffectsDirector({ tables });
    far.onTick(makeTickView([], { freshEvents: true, events: [explosion(9, 0)] }), 0, 0, null);
    const out = new CameraEffectsDirector({ tables });
    out.onTick(makeTickView([], { freshEvents: true, events: [explosion(50, 0)] }), 0, 0, null);
    expect(shakeAmount(near.stack)).toBeGreaterThan(shakeAmount(far.stack));
    expect(shakeAmount(far.stack)).toBeGreaterThan(0);
    expect(isZero(offsetOf(out.stack))).toBe(true); // за радиусом — ноль
  });

  it('реплей не стреляет очередью тряски: freshEvents=false → импульсы молчат (CAM-5)', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1 } } },
    });
    director.onTick(
      makeTickView([], { freshEvents: false, isReplay: true, events: [explosion(0, 0)] }),
      0,
      0,
      null,
    );
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('множитель 0: события и состояния игнорируются без ошибок', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1 } } },
      stack: new EffectStack(0),
    });
    director.onTick(makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }), 0, 0, null);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  /**
   * Сценарий «Множитель ноль» (CAM-6) с той стороны, с какой до выключателя
   * дотягивается АВТОР: множитель — параметр конфига камеры (CAM-1), и
   * приезжает он диспетчеру числом. Сборка, своего стека не приносящая, —
   * обычный случай (так собран демо-клиент), и раньше выключатель ей был
   * недоступен вовсе: стек по умолчанию всегда получал множитель 1.
   */
  it('множитель конфига 0 отключает эффекты и при стеке по умолчанию (CAM-1, CAM-6)', () => {
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'shake', amplitude: 1, decay: 0 } } },
      effectsMultiplier: 0,
    });
    director.onTick(makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }), 0, 0, null);
    for (let i = 0; i < 10; i++) expect(director.stack.apply(LOGICAL, 1 / 60)).toEqual(LOGICAL);
  });

  it('множитель конфига 0.5 — половина амплитуды того же события (CAM-6)', () => {
    const tables = { events: { Boom: { effect: 'shake', amplitude: 1, decay: 0 } } };
    const view = makeTickView([], { freshEvents: true, events: [explosion(0, 0)] });
    // Умолчание множителя — единица: конфиг камеры его таким и объявляет.
    const full = new CameraEffectsDirector({ tables });
    const half = new CameraEffectsDirector({ tables, effectsMultiplier: 0.5 });
    full.onTick(view, 0, 0, null);
    half.onTick(view, 0, 0, null);
    // Тряска детерминирована (value-noise от времени эффекта), стеки идут одним
    // и тем же шагом — значит, отличаться они вправе ровно множителем.
    const amplitude = shakeAmount(full.stack);
    expect(amplitude).toBeGreaterThan(0);
    expect(shakeAmount(half.stack)).toBeCloseTo(amplitude / 2, 12);
  });

  it('длящийся эффект следует присутствию состояния на цели (CAM-6)', () => {
    const hero = 7 as EntityId;
    const director = new CameraEffectsDirector({
      tables: { states: { Drunk: { effect: 'sway', fadeSeconds: 0.05 } } },
      stateComponents: ['Poisoned', 'Drunk'],
    });
    // Состояние присутствует: бит 1 (второй в списке).
    director.onTick(makeTickView([makeEntityView(hero, { states: 0b10 })]), 0, 0, hero);
    for (let i = 0; i < 30; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(false);
    // Состояние исчезло из снапшота — эффект гаснет.
    director.onTick(makeTickView([makeEntityView(hero, { states: 0 })]), 0, 0, hero);
    for (let i = 0; i < 120; i++) director.stack.apply(LOGICAL, 1 / 60);
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });

  it('неизвестный тип эффекта — предупреждение один раз и пропуск (ASSET-8)', () => {
    const warnings: string[] = [];
    const director = new CameraEffectsDirector({
      tables: { events: { Boom: { effect: 'earthquake' } } },
      warn: (m) => warnings.push(m),
    });
    const view = makeTickView([], { freshEvents: true, events: [explosion(0, 0)] });
    director.onTick(view, 0, 0, null);
    director.onTick(view, 0, 0, null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('earthquake');
    expect(isZero(offsetOf(director.stack))).toBe(true);
  });
});

/**
 * CAM-9 и MODIFIED CAM-6: описание типов — единственный перечень, и диспетчер
 * строит эффекты по нему. Проверяется это подставленным описанием: тип,
 * которого в камере нет, обязан работать end-to-end без единой правки
 * диспетчера — ровно то, что требует сценарий «Новый тип эффекта работает без
 * правки диспетчера».
 */
describe('Описание типов эффектов (CAM-9)', () => {
  // Координаты события — float в мировых единицах: перевод сделан на входной
  // границе рендера (REND-1), а `TickView` здесь конструируется уже за ней.
  const explosion = (x: number, y: number) => ({ type: 'Boom', tick: 1, data: { x, y } });

  /** Эффект-свидетель: запоминает поданные числа и сдвигает позу на амплитуду. */
  class Nudge implements ImpulseEffect, LastingEffect {
    strength = 0;
    active = false;
    constructor(readonly params: Readonly<Record<string, number>>) {}
    trigger(strength: number): void {
      this.strength += strength;
    }
    setActive(active: boolean): void {
      this.active = active;
    }
    update(_dt: number, out: PoseOffset): boolean {
      out.dx += this.strength + (this.active ? 1 : 0);
      return true;
    }
  }

  /** Описание с выдуманным типом: в камере его нет, в манифесте — есть. */
  const invented = (
    kind: 'impulse' | 'lasting',
    params: readonly { name: string; defaultValue: number; min?: number; max?: number }[] = [],
  ): { catalog: CameraEffectsCatalog; built: Nudge[] } => {
    const built: Nudge[] = [];
    const create = (values: Readonly<Record<string, number>>): Nudge => {
      const effect = new Nudge(values);
      built.push(effect);
      return effect;
    };
    const type =
      kind === 'impulse'
        ? ({ id: 'gust', kind, params, create } as ImpulseEffectType)
        : ({ id: 'gust', kind, params, create } as LastingEffectType);
    return {
      catalog: {
        types: [type],
        binding: {
          impulse: [{ name: 'amplitude', defaultValue: 0.6, min: 0 }],
          lasting: [],
        },
      },
      built,
    };
  };

  it('описание читается без графики: типы, виды и параметры — просто данные', () => {
    // Ни рендера, ни установки камеры в этом прогоне не создано (CAM-9).
    const ids = CAMERA_EFFECTS_DESCRIPTION.types.map((type) => type.id);
    expect(ids).toContain('shake');
    expect(ids).toContain('sway');
    const shake = CAMERA_EFFECTS_DESCRIPTION.types.find((type) => type.id === 'shake');
    expect(shake?.kind).toBe('impulse');
    // Умолчание типа — то же самое, которым живёт сам эффект: второго места у
    // умолчания нет.
    expect(shake?.params.find((param) => param.name === 'decay')?.defaultValue).toBe(
      DEFAULT_SHAKE.decay,
    );
    // Параметры привязки — часть описания, а не знание диспетчера.
    expect(CAMERA_EFFECTS_DESCRIPTION.binding.impulse.map((param) => param.name)).toEqual([
      'amplitude',
      'radius',
    ]);
    expect(CAMERA_EFFECTS_DESCRIPTION.binding.lasting).toEqual([]);
  });

  it('выдуманный тип из подставленного описания работает end-to-end (CAM-6)', () => {
    const { catalog, built } = invented('impulse');
    const director = new CameraEffectsDirector({
      description: catalog,
      tables: { events: { Boom: { effect: 'gust', amplitude: 0.5 } } },
      warn: () => {
        throw new Error('предупреждений быть не должно');
      },
    });
    director.onTick(makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }), 0, 0, null);
    expect(built).toHaveLength(1);
    expect(built[0]?.strength).toBeCloseTo(0.5);
    // Эффект в стеке и вносит свой вклад — путь пройден целиком.
    expect(isZero(offsetOf(director.stack))).toBe(false);
  });

  it('параметр вне объявленного диапазона приводится к границе, а не отвергается', () => {
    const { catalog, built } = invented('impulse', [
      { name: 'power', defaultValue: 1, min: 0, max: 2 },
      { name: 'bias', defaultValue: 7 },
    ]);
    const director = new CameraEffectsDirector({
      description: catalog,
      tables: { events: { Boom: { effect: 'gust', power: 99, amplitude: -5 } } },
    });
    director.onTick(makeTickView([], { freshEvents: true, events: [explosion(0, 0)] }), 0, 0, null);
    expect(built[0]?.params.power).toBe(2);
    // Незаданный параметр — умолчание описания, а не ноль.
    expect(built[0]?.params.bias).toBe(7);
    // Параметр привязки приводится тем же правилом: кадр не место, где отказывают.
    expect(built[0]?.strength).toBe(0);
  });

  it('тип объявлен эффектом другого вида, чем таблица, — предупреждение и пропуск', () => {
    const warnings: string[] = [];
    const { catalog, built } = invented('impulse');
    const director = new CameraEffectsDirector({
      description: catalog,
      // Импульсный тип в таблице состояний (CAM-6, сценарий).
      tables: { states: { Drunk: { effect: 'gust' } }, events: { Boom: { effect: 'gust' } } },
      stateComponents: ['Drunk'],
      warn: (message) => warnings.push(message),
    });
    const view = makeTickView([], { freshEvents: true, events: [explosion(0, 0)] });
    director.onTick(view, 0, 0, null);
    director.onTick(view, 0, 0, null);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('gust');
    // Запись другой таблицы при этом работает: пропущена одна запись, а не слой.
    expect(built).toHaveLength(1);
  });

  it('в диспетчере нет ни одного идентификатора типа эффекта (CAM-6)', () => {
    // Свойство «перечень типов один» обычным прогоном не ловится: ветка,
    // добавленная «на время», работает. Поэтому сканер исходника — по образцу
    // `editor/ui-ts/test/frameDomain.test.ts`.
    const source = readFileSync(
      fileURLToPath(new URL('../src/camera/director.ts', import.meta.url)),
      'utf8',
    );
    // Комментарии вырезаются: шапка файла объясняет запрет и типы называет.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const type of CAMERA_EFFECTS_DESCRIPTION.types) {
      expect(code.includes(type.id), `диспетчер называет тип "${type.id}"`).toBe(false);
    }
  });
});

describe('Extractor.stateComponents: присутствие компоненты → бит (CAM-6)', () => {
  it('зеркалирует состояния по порядку списка; лишние компоненты — отказ', () => {
    const scene = loadScene({
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Drunk', fields: { power: 'fixed' } },
      ],
      prefabs: [
        { name: 'Sober', components: { Position: {} }, tags: ['Sober'] },
        { name: 'Drunkard', components: { Position: {}, Drunk: {} }, tags: ['Drunkard'] },
      ],
    });
    const sober = worldInitSpawn(scene.world, 'Sober', {
      Position: { x: fixed.fromFloat(1), y: fixed.fromFloat(1) },
    });
    const drunkard = worldInitSpawn(scene.world, 'Drunkard', {
      Position: { x: fixed.fromFloat(2), y: fixed.fromFloat(2) },
      Drunk: { power: fixed.fromFloat(1) },
    });
    const sim: Simulation = { systems: scene.systems, worldSeed: 1, math: mathApi };
    const state = initialState(scene.world, 1);
    const result = tick(sim, state);

    const extractor = new Extractor({
      kindOf: () => null,
      stateComponents: ['Poisoned', 'Drunk'],
    });
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply(extractor.extract(result));
    expect(buffer.view.entities.get(sober)!.states).toBe(0);
    expect(buffer.view.entities.get(drunkard)!.states).toBe(0b10);

    expect(
      () =>
        new Extractor({
          kindOf: () => null,
          stateComponents: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
        }),
    ).toThrow(/stateComponents/);
  });
});

describe('EntityView.states: зеркалирование битов состояний (CAM-6)', () => {
  it('ViewBuffer переносит биты из колонки flags в states', () => {
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    buffer.apply({
      tick: 1,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      freshEvents: true,
      count: 1,
      id: new Float64Array([7]),
      kind: new Int32Array([-1]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      level: new Uint8Array([0]),
      // бит 0 — moving, бит 1 — levelOverride, биты выше — состояния (STATE_BITS_SHIFT).
      flags: new Uint8Array([0b1001]),
      facingYaw: new Float32Array([Number.NaN]),
      aimYaw: new Float32Array([Number.NaN]),
      motion: new Uint8Array([0]),
      motionPhase: new Float32Array([Number.NaN]),
      flightPhase: new Float32Array([Number.NaN]),
      timeScale: new Float32Array([1]),
      statNames: [],
      statCount: new Uint8Array([0]),
      statIndex: new Int32Array(0),
      statValue: new Float64Array(0),
      statPairs: 0,
      events: [],
      floorDelta: [],
      kindTable: [],
    });
    const view = buffer.view.entities.get(7)!;
    expect(view.moving).toBe(true);
    expect(view.states).toBe(0b10);
  });
});
