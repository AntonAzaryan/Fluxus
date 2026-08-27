/**
 * Пресеты качества рендера (`render-quality` QUAL-1..3): реестр ручек,
 * собираемый из деклараций подсистем, контроллер, раздающий им значения
 * документа пресета, валидация документа против реестра — и сами ручки
 * существующих подсистем как рычаги на РЕАЛЬНОМ коде: потолок разрешения маски
 * тумана (FOW-10), множитель порогов LOD (REND-22), ярус представления по
 * умолчанию (REND-20), плотность частиц (REND-24) и потолок разбиения террейна
 * (REND-9).
 *
 * Проверяется наблюдаемое: подсистема получает значения и при ранней, и при
 * поздней регистрации; смена пресета в рантайме доезжает без пересборки
 * рендера; неизвестная ручка отвергается АДРЕСНО; документ сцены пресетом не
 * правится ни байтом.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid } from '@fluxus/core';
import { ParticleEmitter, type ParticleSystem } from 'three.quarks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateCurvatureMap,
  type ParticleEffectDocument,
  type PresentationFog,
  type NormalizedMesh,
  type NormalizedModel,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@fluxus/assets';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  EffectsSubsystem,
  FogSubsystem,
  ModelsSubsystem,
  OverlaySubsystem,
  ParticlesSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  VisualSurfaceSource,
  validateQualityPreset,
  type QualityDeclaration,
  type QualityKnob,
  type QualityValues,
  type RenderContext,
  type RenderSubsystem,
} from '../src/index.js';
import {
  buildFogMask,
  flatGrid,
  makeAssets,
  makeEntityView,
  makeModel,
  makeRenderContext,
  makeTickView,
  type AssetsStub,
} from './fixtures.js';

// ------------------------------------------------------------------ стенд

/**
 * Подсистема-стенд: своё объявление ручек и журнал доставленных значений.
 * Настоящие подсистемы проверяются ниже своими ручками — здесь проверяется сам
 * механизм раздачи (design D2).
 */
class Probe implements RenderSubsystem {
  readonly name: string;
  readonly applied: QualityValues[] = [];
  private readonly declaration: QualityDeclaration;

  constructor(declaration: QualityDeclaration) {
    this.name = declaration.subsystem;
    this.declaration = declaration;
  }

  init(): void {}
  syncTick(): void {}
  updateFrame(): void {}

  quality(): QualityDeclaration {
    return this.declaration;
  }

  applyQuality(values: QualityValues): void {
    this.applied.push(new Map(values));
  }

  /** Последнее доставленное значение ручки; undefined — доставок не было. */
  last(name: string): unknown {
    return this.applied.at(-1)?.get(name);
  }
}

function probe(name: string, knob: string, fallback: number): Probe {
  return new Probe({
    subsystem: name,
    knobs: [
      { name: `${name}.${knob}`, cost: 'ось стенда', semantics: 'value', default: fallback, min: 0, max: 10 },
    ],
  });
}

function makeStage(): PresentationStage {
  return new PresentationStage(makeRenderContext());
}

/**
 * Реестр, собранный из деклараций РЕАЛЬНЫХ подсистем сцены игрового клиента
 * (design D1). Диапазоны, умолчания и перечни тесты берут ЗДЕСЬ, а не из копии
 * объявлений рядом: копия расходится с кодом молча, и первое же расхождение
 * обесценивает проверку, ради которой её и заводили.
 */
function sceneKnobs(): readonly QualityKnob[] {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const grid = flatGrid();
  const stage = new PresentationStage(ctx)
    .register(new TerrainSubsystem(grid))
    .register(new ModelsSubsystem({ entities: {} }, { warn: () => {} }))
    .register(new EffectsSubsystem({ entities: {} }, { warn: () => {} }))
    .register(new ParticlesSubsystem({ entities: {} }, { warn: () => {} }))
    .register(
      new FogSubsystem({
        grid,
        stats: { visionRadius: 'vision', team: 'team' },
        hero: () => null,
      }),
    );
  return new QualityController(stage).knobs;
}

// ------------------------------------------- 1.2: контроллер и раздача

describe('QualityController: раздача значений подсистемам (QUAL-1, design D2)', () => {
  it('ранняя регистрация: подсистема, зарегистрированная ДО контроллера, получает значения', () => {
    const stage = makeStage();
    const early = probe('early', 'lever', 1);
    stage.register(early);

    new QualityController(stage, { 'early.lever': 3 });

    expect(early.applied.length).toBe(1);
    expect(early.last('early.lever')).toBe(3);
  });

  it('поздняя регистрация получает ТЕКУЩИЕ значения пресета', () => {
    const stage = makeStage();
    const controller = new QualityController(stage, { 'late.lever': 7 });
    const late = probe('late', 'lever', 1);

    stage.register(late);

    expect(late.last('late.lever')).toBe(7);
    // Реестр собрался из декларации поздней подсистемы — центрального списка нет.
    expect(controller.knobs.map((knob) => knob.name)).toEqual(['late.lever']);
  });

  it('смена пресета в рантайме доезжает до всех подсистем, не пересобирая рендер', () => {
    const stage = makeStage();
    const first = probe('first', 'lever', 1);
    const second = probe('second', 'lever', 2);
    stage.register(first).register(second);
    const controller = new QualityController(stage);

    expect(first.last('first.lever')).toBe(1); // умолчание декларации
    expect(second.last('second.lever')).toBe(2);

    controller.apply({ 'first.lever': 9, 'second.lever': 0 });

    expect(first.last('first.lever')).toBe(9);
    expect(second.last('second.lever')).toBe(0);
    // Подсистемы те же объекты: смена пресета их не пересоздаёт.
    expect(first.applied.length).toBe(2);
  });

  it('подсистема получает ТОЛЬКО свои ручки (design D2)', () => {
    const stage = makeStage();
    const first = probe('first', 'lever', 1);
    const second = probe('second', 'lever', 2);
    stage.register(first).register(second);
    new QualityController(stage, { 'first.lever': 5, 'second.lever': 6 });

    expect([...first.applied[0]!.keys()]).toEqual(['first.lever']);
    expect([...second.applied[0]!.keys()]).toEqual(['second.lever']);
  });

  it('подсистема без декларации в реестре не появляется и значений не получает', () => {
    const stage = makeStage();
    const silent: RenderSubsystem = {
      name: 'silent',
      init: () => {},
      syncTick: () => {},
      updateFrame: () => {},
    };
    stage.register(silent);
    const controller = new QualityController(stage);

    expect(controller.knobs).toEqual([]);
  });

  it('отчёт печатает действующие значения всех объявленных ручек (design Risks)', () => {
    const stage = makeStage();
    stage.register(probe('first', 'lever', 1)).register(probe('second', 'lever', 2));
    const controller = new QualityController(stage, { 'first.lever': 4 });

    expect(controller.effective()).toEqual(
      new Map([
        ['first.lever', 4],
        ['second.lever', 2],
      ]),
    );
    expect(controller.preset).toEqual({ 'first.lever': 4 });
  });
});

describe('QualityController: дисциплина деклараций (QUAL-1, QUAL-3)', () => {
  it('пустой список ручек без причины отвергается — константность объявляется явно (QUAL-3)', () => {
    const stage = makeStage();
    stage.register(new Probe({ subsystem: 'mute', knobs: [] }));

    expect(() => new QualityController(stage)).toThrow(/константность стоимости объявляется явно/);
  });

  it('пустой список с названной причиной — законная декларация константной стоимости', () => {
    const stage = makeStage();
    stage.register(
      new Probe({ subsystem: 'cheap', knobs: [], constantCost: 'один проход фиксированного разрешения' }),
    );

    const controller = new QualityController(stage);
    expect(controller.knobs).toEqual([]);
  });

  it('ручка вне неймспейса своей подсистемы отвергается', () => {
    const stage = makeStage();
    stage.register(
      new Probe({
        subsystem: 'owner',
        knobs: [{ name: 'stranger.lever', cost: 'ось', semantics: 'value', default: 1 }],
      }),
    );

    expect(() => new QualityController(stage)).toThrow(/не в неймспейсе подсистемы "owner"/);
  });

  it('две подсистемы не могут объявить одну ручку — у оси стоимости один владелец', () => {
    const stage = makeStage();
    const knob = { name: 'twin.lever', cost: 'ось', semantics: 'value', default: 1 } as const;
    stage.register(new Probe({ subsystem: 'twin', knobs: [knob] }));
    const controller = new QualityController(stage);
    expect(controller.knobs.length).toBe(1);

    expect(() => {
      stage.register(new Probe({ subsystem: 'twin', knobs: [knob] }));
    }).toThrow(/уже объявлена/);
  });

  it('отвергнутая декларация не оставляет в реестре ни одной своей ручки', () => {
    const stage = makeStage();
    const controller = new QualityController(stage);

    expect(() => {
      stage.register(
        new Probe({
          subsystem: 'half',
          knobs: [
            { name: 'half.good', cost: 'ось', semantics: 'value', default: 1 },
            { name: 'stranger.lever', cost: 'ось', semantics: 'value', default: 1 },
          ],
        }),
      );
    }).toThrow(/не в неймспейсе подсистемы "half"/);

    // Декларация принимается целиком или не принимается вовсе: годная ручка
    // отвергнутой подсистемы в реестре не остаётся. Иначе она закрывала бы своё
    // имя от следующего владельца, не достаясь при этом никому — доставки
    // значений у неё нет, подсистема в сцену не вошла.
    expect(controller.knobs).toEqual([]);

    stage.register(
      new Probe({
        subsystem: 'half',
        knobs: [{ name: 'half.good', cost: 'ось', semantics: 'value', default: 2 }],
      }),
    );
    expect(controller.knobs.map((knob) => knob.name)).toEqual(['half.good']);
  });

  it('две ручки одного имени внутри ОДНОЙ декларации — тот же отказ', () => {
    const stage = makeStage();
    const knob = { name: 'solo.lever', cost: 'ось', semantics: 'value', default: 1 } as const;
    const controller = new QualityController(stage);

    expect(() => {
      stage.register(new Probe({ subsystem: 'solo', knobs: [knob, knob] }));
    }).toThrow(/уже объявлена/);
    expect(controller.knobs).toEqual([]);
  });
});

// ------------------------------------------------- 1.3: валидация документа

describe('валидация документа пресета против реестра (QUAL-1)', () => {
  // Реестр настоящий: границы, на которые ссылаются отказы ниже, — те самые,
  // что объявляют подсистемы, а не переписанные в тест от руки.
  const knobs = sceneKnobs();

  it('неизвестная ручка отвергается адресно — с её именем, а не молчаливым пропуском', () => {
    const result = validateQualityPreset({ 'fog.maskResolutoin': 4 }, knobs);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('ожидался отказ');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('fog.maskResolutoin');
    expect(result.errors[0]).toContain('неизвестная ручка качества');
    // Отказ называет и то, что реестр объявлял: опечатка чинится с одного взгляда.
    expect(result.errors[0]).toContain('fog.maskResolution');
  });

  it('отсутствующая ручка ошибкой не является — у неё документированное умолчание', () => {
    const result = validateQualityPreset({}, knobs);

    expect(result.ok).toBe(true);
    const stage = makeStage();
    const fog = probe('fog', 'lever', 4);
    stage.register(fog);
    new QualityController(stage, {});
    expect(fog.last('fog.lever')).toBe(4);
  });

  it('значение вне диапазона — отказ с границами', () => {
    const result = validateQualityPreset({ 'fog.maskResolution': 128 }, knobs);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('ожидался отказ');
    expect(result.errors[0]).toContain('fog.maskResolution');
    expect(result.errors[0]).toContain('[0.5, 32]');
    expect(result.errors[0]).toContain('128');
  });

  it('значение не того типа — отказ; бесконечность числом не считается', () => {
    const wrongType = validateQualityPreset({ 'fog.maskResolution': 'высокое' }, knobs);
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) throw new Error('ожидался отказ');
    expect(wrongType.errors[0]).toContain('"высокое"');

    const infinite = validateQualityPreset({ 'fog.maskResolution': Number.POSITIVE_INFINITY }, knobs);
    expect(infinite.ok).toBe(false);
  });

  it('значение вне закрытого перечня — отказ со списком допустимых', () => {
    const result = validateQualityPreset({ 'models.defaultTier': 'ultra' }, knobs);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('ожидался отказ');
    expect(result.errors[0]).toContain('models.defaultTier');
    expect(result.errors[0]).toContain('"batched" | "detailed"');
  });

  it('ошибки собираются все разом, а документ не-объект отвергается целиком', () => {
    const many = validateQualityPreset({ 'fog.maskResolution': 128, 'models.defaultTier': 1 }, knobs);
    expect(many.ok).toBe(false);
    if (many.ok) throw new Error('ожидался отказ');
    expect(many.errors).toHaveLength(2);

    const notObject = validateQualityPreset([], knobs);
    expect(notObject.ok).toBe(false);
    if (notObject.ok) throw new Error('ожидался отказ');
    expect(notObject.errors[0]).toContain('массив');
  });

  it('контроллер отвергает негодное значение известной ручки и пресета не применяет', () => {
    const stage = makeStage();
    const lever = probe('fog', 'lever', 4);
    stage.register(lever);
    const controller = new QualityController(stage, {});

    expect(() => {
      controller.apply({ 'fog.lever': 99 });
    }).toThrow(/fog\.lever/);
    // Ни документ, ни подсистема не тронуты: полупримененного пресета не бывает.
    expect(controller.preset).toEqual({});
    expect(lever.applied.length).toBe(1);
  });

  it('текущий документ проверяется против собранного реестра целиком', () => {
    const stage = makeStage();
    stage.register(probe('fog', 'lever', 4));
    const controller = new QualityController(stage, { 'fog.lever': 2 });
    expect(controller.validate().ok).toBe(true);

    const stray = new QualityController(makeStage(), { 'ghost.lever': 2 });
    const result = stray.validate();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('ожидался отказ');
    expect(result.errors[0]).toContain('ghost.lever');
  });
});

// ------------------------------ 2.1: fog.maskResolution как потолок (FOW-10)

describe('fog.maskResolution — потолок над сценным значением (FOW-10, QUAL-1, design D3)', () => {
  const STATS = { visionRadius: 'vision', team: 'team' } as const;

  /**
   * Ширина кромки стенда (FOW-10) — часть стенда, а не проверяемое поведение.
   * Стенд — арена 8×8 с радиусом обзора 3, а умолчание `edgeWidth` задано в
   * МИРОВЫХ единицах под арену демо: на здешнем круге оно съело бы под градиент
   * почти всю площадь, и «зона открыта» проверялось бы полутоном. Здесь речь о
   * потолке разрешения маски, кромка к нему отношения не имеет.
   *
   * Число едет в секцию КАЖДОГО стенда, а не подмешивается `fogRig`: подсистема
   * обязана получить сам объект вызывающего, иначе тест «потолок не правит
   * документ сцены» (QUAL-1, FOW-10) стережёт копию и не может упасть никогда.
   */
  const STAND_EDGE = 1.5;

  function fogRig(section?: PresentationFog) {
    const stage = makeStage();
    const fog = new FogSubsystem({
      grid: flatGrid(),
      stats: STATS,
      hero: () => 1,
      ...(section === undefined ? {} : { config: section }),
    });
    stage.register(fog);
    return { stage, fog };
  }

  function observer(x: number, y: number, vision: number) {
    return makeEntityView(1, {
      currX: x,
      currY: y,
      prevX: x,
      prevY: y,
      stats: new Map([
        [STATS.team, 0],
        [STATS.visionRadius, vision],
      ]),
    });
  }

  it('сцена 8 + потолок 4 → маска строится на 4 текселях/юнит', () => {
    const { stage, fog } = fogRig({ edgeWidth: STAND_EDGE, resolution: 8 });
    expect(fog.visibility.texelsPerUnit).toBe(8);

    new QualityController(stage, { 'fog.maskResolution': 4 });

    expect(fog.visibility.texelsPerUnit).toBe(4);
    expect(fog.config.resolution).toBe(4);
  });

  it('пресета без потолка достаточно, чтобы действовало сценное значение 8', () => {
    const { stage, fog } = fogRig({ edgeWidth: STAND_EDGE, resolution: 8 });
    new QualityController(stage, {});

    expect(fog.visibility.texelsPerUnit).toBe(8);
    expect(fog.config.resolution).toBe(8);
  });

  it('потолок ВЫШЕ сценного значения его не поднимает — семантика min', () => {
    const { stage, fog } = fogRig({ edgeWidth: STAND_EDGE, resolution: 8 });
    new QualityController(stage, { 'fog.maskResolution': 16 });

    expect(fog.visibility.texelsPerUnit).toBe(8);
  });

  it('документ сцены не меняется ни байтом — потолок живёт в подсистеме', () => {
    const section: PresentationFog = { resolution: 8, strength: 0.7 };
    const before = JSON.stringify(section);
    Object.freeze(section);
    const { stage, fog } = fogRig(section);

    const controller = new QualityController(stage, { 'fog.maskResolution': 2 });
    controller.apply({ 'fog.maskResolution': 1 });

    expect(JSON.stringify(section)).toBe(before);
    expect(section.resolution).toBe(8);
    // Прочие поля секции потолок не трогает вовсе.
    expect(fog.config.strength).toBe(0.7);
    expect(fog.config.resolution).toBe(1);
  });

  it('смена потолка в рантайме идёт живой подсистемой — пересборки рендера нет', () => {
    const { stage, fog } = fogRig({ edgeWidth: STAND_EDGE, resolution: 8 });
    const controller = new QualityController(stage, {});
    // Растр строит кадр порциями, а не доставка (change
    // `fog-mask-budgeted-rebuild`, design D1).
    fog.syncTick(makeTickView([observer(4, 4, 3)]));
    buildFogMask(fog);
    expect(fog.visibility.valueAt(4, 4)).toBe(1);

    controller.apply({ 'fog.maskResolution': 2 });

    expect(fog.visibility.texelsPerUnit).toBe(2);
    fog.syncTick(makeTickView([observer(4, 4, 3)]));
    buildFogMask(fog);
    expect(fog.visibility.valueAt(4, 4)).toBe(1);
  });

  it('консервативность reveal (FOW-9) сохраняется на грубой маске', () => {
    const { stage, fog } = fogRig({ resolution: 8, conservatism: 0.9, edgeWidth: 0 });
    const controller = new QualityController(stage, {});
    fog.syncTick(makeTickView([observer(4, 4, 3)]));
    buildFogMask(fog);
    // Визуал уже консервативнее геймплея: 3 × 0.9 = 2.7. Проверочная точка —
    // на самом геймплейном радиусе, а не вплотную к визуальному: блюр кромки
    // (FOW-7) переносит свет до текселя за геометрию круга (0.125 юнита на
    // разрешении 8), и запас консервативности (0.3 юнита) его перекрывает.
    expect(fog.visibility.valueAt(4 + 3, 4)).toBe(0);
    // Внутри визуального радиуса свет есть — проверка не выродилась в «всюду туман».
    expect(fog.visibility.valueAt(4 + 2, 4)).toBeGreaterThan(0);

    controller.apply({ 'fog.maskResolution': 2 });
    fog.syncTick(makeTickView([observer(4, 4, 3)]));
    buildFogMask(fog);

    // Грубая маска ошибается в ту же сторону: показать лишний туман можно,
    // открыть скрытое — нет. Радиус геймплея наружу не выходит.
    expect(fog.visibility.texelsPerUnit).toBe(2);
    expect(fog.visibility.valueAt(4, 4)).toBe(1);
    expect(fog.visibility.valueAt(4 + 3, 4)).toBe(0);
    expect(fog.visibility.valueAt(4 + 3.5, 4)).toBe(0);
  });
});

// ---------------------------- 2.2: ручки прочих стоимостных осей

const MODEL_ID = 'models/runner.mdx';

function modelsManifest(extra: Record<string, unknown> = {}): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        animations: { states: { idle: 'Stand', move: 'Walk' } },
        ...extra,
      },
    },
  };
}

/** Та же модель с цепочкой из двух упрощённых уровней (ASSET-12, REND-22). */
function modelWithChain(): NormalizedModel {
  const base = makeModel();
  const mesh = base.meshes[0]!;
  const coarse = (): readonly NormalizedMesh[] => [{ ...mesh }];
  return { ...base, lodMeshes: [coarse(), coarse()] };
}

interface ModelsRig {
  readonly stage: PresentationStage;
  readonly subsystem: ModelsSubsystem;
  readonly assets: AssetsStub;
  frameAt(distance: number): void;
}

function modelsRig(manifest: VisualManifest, camera?: THREE.PerspectiveCamera): ModelsRig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const stage = new PresentationStage(ctx);
  const subsystem = new ModelsSubsystem(manifest, {
    warn: () => {},
    ...(camera === undefined ? {} : { camera }),
  });
  stage.register(subsystem);
  return {
    stage,
    subsystem,
    assets,
    frameAt(distance: number): void {
      if (camera === undefined) return;
      camera.position.set(-distance, 0, 0);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld(true);
      subsystem.updateFrame(1 / 60, 1);
    },
  };
}

describe('models.lodThresholdScale — множитель порогов LOD (REND-22, QUAL-1)', () => {
  function distanceForLevel(rig: ModelsRig, level: number): number {
    for (let distance = 1; distance < 4000; distance *= 1.02) {
      rig.frameAt(distance);
      if (rig.subsystem.instanceFor(1)!.lodLevel >= level) return distance;
    }
    throw new Error(`уровень ${level} не достигнут`);
  }

  function placed(scale?: number): ModelsRig {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    const rig = modelsRig(modelsManifest({ lodThresholds: [0.2, 0.05] }), camera);
    new QualityController(rig.stage, scale === undefined ? {} : { 'models.lodThresholdScale': scale });
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, modelWithChain());
    return rig;
  }

  it('множитель больше единицы переводит инстанс на грубый уровень раньше', () => {
    const baseline = distanceForLevel(placed(), 1);
    const cheaper = distanceForLevel(placed(4), 1);

    // Пороги записи (ASSET-13) остались теми же — раньше их читает пресет.
    expect(cheaper).toBeLessThan(baseline);
    expect(baseline / cheaper).toBeGreaterThan(2.5);
  });

  it('умолчание ручки — единица: пресет без неё поведения не меняет', () => {
    const withoutPreset = distanceForLevel(placed(), 1);
    const explicitOne = distanceForLevel(placed(1), 1);

    expect(explicitOne).toBe(withoutPreset);
  });
});

describe('models.defaultTier — ярус записей, ярус не назвавших (REND-20, QUAL-1)', () => {
  function placed(manifest: VisualManifest = modelsManifest()) {
    const rig = modelsRig(manifest);
    const controller = new QualityController(rig.stage, {});
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    return { ...rig, controller };
  }

  it('умолчание — батчевый ярус, как и без контроллера качества', () => {
    const rig = placed();
    expect(rig.subsystem.instanceFor(1)!.tier).toBe('batched');
  });

  it('пресет с детальным ярусом пересобирает запись, ярус не назвавшую', () => {
    const rig = placed();

    rig.controller.apply({ 'models.defaultTier': 'detailed' });

    const instance = rig.subsystem.instanceFor(1)!;
    expect(instance.tier).toBe('detailed');
    // Детальный ярус — пер-инстансное поддерево со скелетом (REND-20).
    expect(instance.model).not.toBeNull();
  });

  it('явный ярус записи пресету не подчиняется — это решение автора (ASSET-13)', () => {
    const rig = placed(modelsManifest({ tier: 'batched' }));

    rig.controller.apply({ 'models.defaultTier': 'detailed' });

    expect(rig.subsystem.instanceFor(1)!.tier).toBe('batched');
  });

  it('запись с процедурным контролем костей остаётся детальной (REND-5)', () => {
    const rig = placed(
      modelsManifest({ boneControls: [{ bone: 'Bone_Chest', role: 'aim', axis: 'z', maxDeg: 45 }] }),
    );

    rig.controller.apply({ 'models.defaultTier': 'batched' });

    expect(rig.subsystem.instanceFor(1)!.tier).toBe('detailed');
  });
});

describe('particles.density — множитель плотности частиц (REND-24, QUAL-1)', () => {
  const TORCH = 'vfx/torch.effect.json';
  const torchDoc = JSON.parse(
    readFileSync(fileURLToPath(new URL('./fixtures/torch.effect.json', import.meta.url)), 'utf8'),
  ) as ParticleEffectDocument;

  /** Эмиссия во времени первой системы эмиттера — то, что правит ручка. */
  function emissionOf(object: THREE.Object3D): number {
    let value = Number.NaN;
    object.traverse((child) => {
      if (!(child instanceof ParticleEmitter) || Number.isFinite(value)) return;
      const system = child.system as ParticleSystem;
      value = system.emissionOverTime.genValue([], 0);
    });
    return value;
  }

  function particlesRig() {
    const assets = makeAssets();
    assets.resolve('particle-effect', TORCH, torchDoc);
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const stage = new PresentationStage(ctx);
    const manifest: VisualManifest = {
      entities: {},
      particles: { byKind: { Runner: { effect: TORCH } } },
    };
    const subsystem = new ParticlesSubsystem(manifest, { warn: () => {} });
    stage.register(subsystem);
    return { stage, subsystem };
  }

  it('множитель правит эмиссию живого эмиттера, не трогая документ эффекта', () => {
    const rig = particlesRig();
    const controller = new QualityController(rig.stage, {});
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const documentEmission = emissionOf(rig.subsystem.emitterFor(1)!.object);
    expect(documentEmission).toBeGreaterThan(0);

    controller.apply({ 'particles.density': 0.25 });

    expect(emissionOf(rig.subsystem.emitterFor(1)!.object)).toBeCloseTo(documentEmission * 0.25, 6);
    // Документ — разделяемый ассет: множитель в нём не оседает (design D6).
    expect(JSON.stringify(torchDoc)).toContain('"emissionOverTime"');
  });

  it('возврат к единице возвращает документную эмиссию', () => {
    const rig = particlesRig();
    const controller = new QualityController(rig.stage, { 'particles.density': 0.5 });
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const halved = emissionOf(rig.subsystem.emitterFor(1)!.object);

    controller.apply({ 'particles.density': 1 });

    expect(emissionOf(rig.subsystem.emitterFor(1)!.object)).toBeCloseTo(halved * 2, 6);
  });

  it('эмиттер, появившийся после смены пресета, играет с текущей плотностью', () => {
    const rig = particlesRig();
    const controller = new QualityController(rig.stage, {});
    rig.subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const full = emissionOf(rig.subsystem.emitterFor(1)!.object);

    controller.apply({ 'particles.density': 0.5 });
    // Прежний эмиттер уходит, новый берётся из пула — множитель тот же.
    rig.subsystem.syncTick(makeTickView([]));
    rig.subsystem.syncTick(makeTickView([makeEntityView(2)]));

    expect(emissionOf(rig.subsystem.emitterFor(2)!.object)).toBeCloseTo(full * 0.5, 6);
  });
});

describe('terrain.curvatureTessellation — потолок разбиения (REND-9, QUAL-1)', () => {
  const SIZE = 4;

  function rows(fill: string): string[] {
    return Array.from({ length: SIZE }, () => fill.repeat(SIZE));
  }

  function curvature(): TerrainCurvatureMap {
    const map = Array.from({ length: SIZE + 1 }, () => new Array<number>(SIZE + 1).fill(0));
    for (const y of [1, 2]) for (const x of [1, 2]) map[y]![x] = 14;
    const result = validateCurvatureMap({ width: SIZE, height: SIZE, rows: map });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.map;
  }

  function terrainRig() {
    const grid = createTerrainGrid({
      width: SIZE,
      height: SIZE,
      tileSize: FIXED_ONE,
      levels: rows('0'),
      flags: rows('.'),
    });
    const surface = new VisualSurfaceSource(grid);
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: makeAssets().service,
      config: { heightStep: 0.5 },
    };
    const stage = new PresentationStage(ctx);
    const subsystem = new TerrainSubsystem(grid, { surface });
    stage.register(subsystem);
    surface.setCurvature(curvature());
    subsystem.updateFrame(0.016, 1);
    return { stage, subsystem };
  }

  it('потолок ниже конфига делает разбиение грубее — вершин становится меньше', () => {
    const rig = terrainRig();
    const controller = new QualityController(rig.stage, {});
    const authored = rig.subsystem.floorVertexCount;
    // Клетки с кривизной разбиты по умолчанию кода (REND-9).
    expect(authored).toBeGreaterThan(SIZE * SIZE * 4);

    controller.apply({ 'terrain.curvatureTessellation': 2 });

    const clamped = rig.subsystem.floorVertexCount;
    expect(clamped).toBeLessThan(authored);
    // Подклеток стало квадратом отношения меньше: 4×4 → 2×2 на клетку.
    const curved = (authored - SIZE * SIZE * 4) / (DEFAULT_CURVATURE_TESSELLATION ** 2 * 4 - 4);
    expect(clamped).toBe(curved * 2 * 2 * 4 + (SIZE * SIZE - curved) * 4);
  });

  it('потолок выше конфига разбиение не поднимает — семантика min', () => {
    const rig = terrainRig();
    const authored = rig.subsystem.floorVertexCount;

    new QualityController(rig.stage, { 'terrain.curvatureTessellation': 16 });

    expect(rig.subsystem.floorVertexCount).toBe(authored);
  });
});

// ------------------------------ 2.3: объявления константной стоимости

describe('константная стоимость объявляется явно (QUAL-3)', () => {
  it('подсистемы эффектов и наложений объявляют её причиной, а ручек не заводят', () => {
    for (const subsystem of [
      new EffectsSubsystem({ entities: {} }, { warn: () => {} }),
      new OverlaySubsystem(),
    ] as RenderSubsystem[]) {
      const declaration = subsystem.quality!();
      expect(declaration.subsystem).toBe(subsystem.name);
      expect(declaration.knobs).toEqual([]);
      expect(declaration.constantCost).toBeTruthy();
    }
  });

  it('реестр сцены игрового клиента собирается из деклараций всех подсистем', () => {
    const knobs = sceneKnobs();

    expect(knobs.map((knob) => knob.name).sort()).toEqual([
      'fog.maskResolution',
      'models.defaultTier',
      'models.lodThresholdScale',
      'particles.density',
      'terrain.curvatureTessellation',
    ]);
    // Каждая ручка называет свою стоимостную ось и семантику (QUAL-1).
    for (const knob of knobs) {
      expect(knob.cost.length).toBeGreaterThan(0);
      expect(['ceiling', 'value']).toContain(knob.semantics);
    }
  });

  it('границы и умолчания ручек сцены закреплены поимённо (QUAL-1)', () => {
    // Не «диапазон непуст», а ТОЧНЫЕ значения: диапазон — публичный контракт
    // документа пресета (его печатает отказ валидации), и молча съехать он не
    // вправе. Таблица снимается с собранного реестра, поэтому расхождение с
    // объявлением подсистемы невозможно — ронять её будет правка кода.
    const declared = new Map(sceneKnobs().map((knob) => [knob.name, knob]));
    const shape = (name: string): Record<string, unknown> => {
      const knob = declared.get(name);
      if (knob === undefined) throw new Error(`ручка ${name} реестром не объявлена`);
      return {
        semantics: knob.semantics,
        default: knob.default,
        min: knob.min,
        max: knob.max,
        values: knob.values,
      };
    };

    // Потолки: умолчание — «потолка нет», действует авторское значение
    // (FOW-10, REND-9), а диапазон описывает то, что вправе написать автор
    // пресета.
    expect(shape('fog.maskResolution')).toEqual({
      semantics: 'ceiling',
      default: Number.POSITIVE_INFINITY,
      min: 0.5,
      max: 32,
      values: undefined,
    });
    expect(shape('terrain.curvatureTessellation')).toEqual({
      semantics: 'ceiling',
      default: Number.POSITIVE_INFINITY,
      min: 1,
      max: 16,
      values: undefined,
    });

    // Множитель порогов LOD — только ВВЕРХ от единицы: пресет вправе удешевить
    // картинку, но не обогатить её сверх порогов автора записи (ASSET-13,
    // REND-22) — то же одностороннее ограничение, что у потолков выше.
    expect(shape('models.lodThresholdScale')).toEqual({
      semantics: 'value',
      default: 1,
      min: 1,
      max: 8,
      values: undefined,
    });

    expect(shape('particles.density')).toEqual({
      semantics: 'value',
      default: 1,
      min: 0,
      max: 4,
      values: undefined,
    });

    // Закрытый перечень вместо диапазона: ярус — не число.
    expect(shape('models.defaultTier')).toEqual({
      semantics: 'value',
      default: 'batched',
      min: undefined,
      max: undefined,
      values: ['batched', 'detailed'],
    });
  });
});
