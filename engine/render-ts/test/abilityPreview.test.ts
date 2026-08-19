/**
 * Подсистема превью каста (REND-28): изображение того, что заденет способность,
 * если подтвердить её сейчас.
 *
 * Проверяется наблюдаемое: входов ровно два — скомпилированный каталог сцены и
 * локальный сэмпл ввода, — подтверждённые шаги рисуются по доставленному
 * состоянию своего слота, текущий следует за курсором по часам кадра, а игрок,
 * не начавший каст, получает тот же кадр, что и без подсистемы вовсе. Чужой
 * каст этой подсистемой не рисуется (NET-15): у клиента нет чужого
 * неподтверждённого прицеливания.
 *
 * Каталог берётся у ядра тем же путём, каким его получит клиент, — загрузкой
 * сцены (`loadScene(...).abilities`): второго разбора определений в рендере
 * не появляется (ABIL-5).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ABILITY_STEPS,
  FIXED_ONE,
  NO_ENTITY,
  loadScene,
  type AbilityCatalog,
  type EntityId,
  type SceneDef,
} from '@game-mvp/core';
import {
  AbilityPreviewSubsystem,
  PresentationStage,
  RenderDebugLayer,
  createCostCounters,
  withCostSink,
  type AbilitySlotStatNames,
  type AbilityStepStatNames,
  type EntityView,
  type RenderContext,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeTickView } from './fixtures.js';

const F = (value: number): number => Math.round(value * FIXED_ONE);

/**
 * Сцена с определениями всех интересных фигур словаря (ABIL-5, design D10):
 * круг области, цепочка «цель, затем вектор», конус (круг с полууглом) и
 * способность с ВЫЧИСЛЯЕМЫМ радиусом — рисовать её рендеру нечем.
 */
const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Input', fields: { buttons: 'i32', prevButtons: 'i32' } },
  ],
  abilities: [
    {
      id: 'zone',
      trigger: { input: { bit: 0 } },
      targeting: { steps: [{ kind: 'point', shape: { kind: 'circle', radius: F(2) } }] },
      effects: [],
    },
    {
      id: 'grab',
      trigger: { input: { bit: 1 } },
      targeting: {
        steps: [
          { kind: 'unit', shape: { kind: 'circle', radius: F(0.5) } },
          { kind: 'vector', shape: { kind: 'aabb', halfX: F(3), halfY: F(0.5) } },
        ],
      },
      effects: [],
    },
    {
      id: 'cone',
      trigger: { input: { bit: 2 } },
      targeting: {
        steps: [{ kind: 'point', shape: { kind: 'circle', radius: F(3), halfAngle: F(0.125) } }],
      },
      effects: [],
    },
    {
      id: 'scaled',
      trigger: { input: { bit: 3 } },
      targeting: {
        steps: [{ kind: 'point', shape: { kind: 'circle', radius: { var: 'level' } } }],
      },
      effects: [],
    },
  ],
};

const ZONE = 0;
const GRAB = 1;
const CONE = 2;
const SCALED = 3;

/** Имена статов доставки слота — их объявляет сборка (HUD-8), не рендер. */
function slotStats(slot: number): AbilitySlotStatNames {
  const steps: AbilityStepStatNames[] = [];
  for (let i = 0; i < ABILITY_STEPS; i++) {
    steps.push({
      x: `slot${slot}.step${i}x`,
      y: `slot${slot}.step${i}y`,
      entity: `slot${slot}.step${i}e`,
    });
  }
  return {
    ability: `slot${slot}.abilityId`,
    phase: `slot${slot}.phase`,
    staged: `slot${slot}.staged`,
    steps,
  };
}

/** Доставленное состояние слота статами: значения уже во float (граница REND-1). */
interface SlotState {
  readonly slot?: number;
  readonly ability: number;
  readonly phase: number;
  readonly staged?: number;
  readonly steps?: readonly { readonly x?: number; readonly y?: number; readonly entity?: EntityId }[];
}

function withSlot(entity: EntityId, state: SlotState, partial: Partial<EntityView> = {}): EntityView {
  const slot = state.slot ?? 0;
  const stats = new Map<string, number>([
    [`slot${slot}.abilityId`, state.ability],
    [`slot${slot}.phase`, state.phase],
    [`slot${slot}.staged`, state.staged ?? 0],
  ]);
  (state.steps ?? []).forEach((step, i) => {
    if (step.x !== undefined) stats.set(`slot${slot}.step${i}x`, step.x);
    if (step.y !== undefined) stats.set(`slot${slot}.step${i}y`, step.y);
    stats.set(`slot${slot}.step${i}e`, step.entity ?? NO_ENTITY);
  });
  return makeEntityView(entity, { kind: null, stats, ...partial });
}

function catalog(): AbilityCatalog {
  const abilities = loadScene(SCENE).abilities;
  if (abilities === undefined) throw new Error('сцена обязана дать каталог определений');
  return abilities;
}

const HERO = 1 as EntityId;
const VICTIM = 2 as EntityId;
const ENEMY = 3 as EntityId;

function makeRig(slots = [slotStats(0), slotStats(1)]) {
  const assets = makeAssets();
  const scene = new THREE.Scene();
  const ctx: RenderContext = { scene, assets: assets.service, config: { heightStep: 0.5 } };
  const stage = new PresentationStage(ctx);
  const preview = new AbilityPreviewSubsystem(catalog(), { slots });
  stage.register(preview);
  return { scene, stage, preview };
}

/** Контуры кадра в порядке отрисовки: видимые узлы группы превью. */
function shapes(scene: THREE.Scene): THREE.Object3D[] {
  const group = scene.children.find((child) => child.name === 'abilityPreview');
  return group === undefined ? [] : group.children.filter((child) => child.visible);
}

describe('Превью каста: два входа и только два (REND-28)', () => {
  it('кадр игрока без активного каста не отличается от кадра без подсистемы', () => {
    const bare = new THREE.Scene();
    const rig = makeRig();
    // Без сэмпла: подсистема зарегистрирована, но входа у неё нет.
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: -1 })]));
    rig.stage.frame(0.016, 0.5);
    expect(rig.preview.shapeCount).toBe(0);
    expect(rig.preview.objectCount).toBe(0);
    expect(rig.scene.children.length).toBe(bare.children.length);

    // Сэмпл есть, каста нет: кадр по-прежнему тот же.
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(4), y: F(1) } });
    rig.stage.frame(0.016, 0.5);
    expect(rig.preview.shapeCount).toBe(0);
    expect(rig.scene.children.length).toBe(bare.children.length);
  });

  it('круг области рисуется в точке прицела локального сэмпла', () => {
    const rig = makeRig();
    rig.stage.publish(
      { name: 'test' },
      makeTickView([withSlot(HERO, { ability: ZONE, phase: 0, staged: 0 })]),
    );
    // Точка приезжает в Q16.16 и становится float в точке приёма (REND-1).
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(5), y: F(-7) } });
    rig.stage.frame(0.016, 1);

    const drawn = shapes(rig.scene);
    expect(drawn.length).toBe(1);
    expect(drawn[0]!.position.x).toBeCloseTo(5, 6);
    expect(drawn[0]!.position.y).toBeCloseTo(-7, 6);
    // Масштаб контура — радиус определения; второго числа у рендера нет (ABIL-5).
    expect(drawn[0]!.scale.x).toBeCloseTo(2, 6);
  });

  it('круг следует за курсором по часам кадра, а не по тикам', () => {
    const rig = makeRig();
    rig.stage.publish(
      { name: 'test' },
      makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]),
    );
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(1), y: F(1) } });
    rig.stage.frame(0.016, 1);
    const objects = rig.scene.children.length;

    // Ни одной доставки между кадрами — только новый сэмпл.
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(6), y: F(2) } });
    rig.stage.frame(0.016, 1);
    const drawn = shapes(rig.scene);
    expect(drawn.length).toBe(1);
    expect(drawn[0]!.position.x).toBeCloseTo(6, 6);
    // Контур переиспользован: установившийся кадр объектов не плодит (REND-26).
    expect(rig.scene.children.length).toBe(objects);
  });

  it('конус — круг с полууглом, заякоренный на кастере и развёрнутый на точку', () => {
    const rig = makeRig();
    rig.stage.publish(
      { name: 'test' },
      makeTickView([
        withSlot(HERO, { ability: CONE, phase: 0 }, { prevX: 2, currX: 2, prevY: 2, currY: 2 }),
      ]),
    );
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(9) } });
    rig.stage.frame(0.016, 1);

    const drawn = shapes(rig.scene);
    expect(drawn.length).toBe(1);
    // Вершина сектора — кастер, а не точка прицела.
    expect(drawn[0]!.position.x).toBeCloseTo(2, 6);
    expect(drawn[0]!.position.y).toBeCloseTo(2, 6);
    expect(drawn[0]!.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(drawn[0]!.scale.x).toBeCloseTo(3, 6);
  });

  it('вычисляемый размер фигуры не рисуется: мира у рендера нет', () => {
    const rig = makeRig();
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: SCALED, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(3), y: F(3) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(0);
  });

  it('стоимость объявлена константной, ручек нет (QUAL-3)', () => {
    const rig = makeRig();
    const declaration = rig.preview.quality();
    expect(declaration.subsystem).toBe('abilityPreview');
    expect(declaration.knobs).toEqual([]);
    expect(declaration.constantCost).toBeTruthy();
  });

  it('слот, объявивший больше шагов, чем есть у слота, — ошибка сборки', () => {
    const steps: AbilityStepStatNames[] = [];
    for (let i = 0; i <= ABILITY_STEPS; i++) {
      steps.push({ x: `x${i}`, y: `y${i}`, entity: `e${i}` });
    }
    expect(
      () =>
        new AbilityPreviewSubsystem(catalog(), {
          slots: [{ ability: 'a', phase: 'p', staged: 's', steps }],
        }),
    ).toThrow(/ABIL-1/);
  });
});

describe('Превью каста: цепочка шагов (REND-28)', () => {
  /** Кадр цепочки «цель, затем вектор»: первый шаг подтверждён, второй выбирают. */
  function chainRig() {
    const rig = makeRig();
    const hero = withSlot(
      HERO,
      { ability: GRAB, phase: 1, staged: 1, steps: [{ x: 9, y: 9, entity: VICTIM }] },
      { prevX: 1, currX: 1, prevY: 0, currY: 0 },
    );
    const victim = makeEntityView(VICTIM, { prevX: 4, currX: 4, prevY: 0, currY: 0 });
    rig.stage.publish({ name: 'test' }, makeTickView([hero, victim]));
    return rig;
  }

  it('подтверждённая цель — по доставленному состоянию, текущий шаг — по вводу', () => {
    const rig = chainRig();
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(1), y: F(8) } });
    rig.stage.frame(0.016, 1);

    const drawn = shapes(rig.scene);
    expect(drawn.length).toBe(2);
    // Подтверждённый шаг стоит на СУЩНОСТИ шага, а не на записанной точке:
    // цель могла сдвинуться с тика подтверждения.
    expect(drawn[0]!.position.x).toBeCloseTo(4, 6);
    expect(drawn[0]!.position.y).toBeCloseTo(0, 6);
    expect(drawn[0]!.scale.x).toBeCloseTo(0.5, 6);
    // Текущий шаг — вектор от кастера на точку локального сэмпла.
    expect(drawn[1]!.rotation.z).toBeCloseTo(Math.PI / 2, 6);
    expect(drawn[1]!.scale.x).toBeCloseTo(3, 6);
    expect(drawn[1]!.scale.y).toBeCloseTo(0.5, 6);
  });

  it('сущность шага исчезла — подтверждённый шаг рисуется по записанной точке', () => {
    const rig = makeRig();
    const hero = withSlot(HERO, {
      ability: GRAB,
      phase: 1,
      staged: 1,
      steps: [{ x: 9, y: -2, entity: VICTIM }],
    });
    // Цели в доставленном состоянии нет: умерла либо ушла в туман (FOW-8).
    rig.stage.publish({ name: 'test' }, makeTickView([hero]));
    rig.preview.applyLocalInput({ entity: HERO, target: null });
    rig.stage.frame(0.016, 1);

    const drawn = shapes(rig.scene);
    expect(drawn.length).toBe(1);
    expect(drawn[0]!.position.x).toBeCloseTo(9, 6);
    expect(drawn[0]!.position.y).toBeCloseTo(-2, 6);
  });

  it('точки в сэмпле нет — текущий шаг не рисуется, подтверждённый остаётся', () => {
    const rig = chainRig();
    rig.preview.applyLocalInput({ entity: HERO, target: null });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(1);
  });

  it('каст подтверждён — превью гаснет, а группа уходит из сцены', () => {
    const rig = chainRig();
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(1), y: F(8) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(2);

    // Фаза кончилась: доставленное состояние говорит «каста нет» (ABIL-1).
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: GRAB, phase: -1 })]));
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(0);
    expect(rig.preview.objectCount).toBe(0);
  });
});

describe('Превью каста: только свой игрок (NET-15)', () => {
  it('противник заряжает способность — его прицеливание не рисуется', () => {
    const rig = makeRig();
    rig.stage.publish(
      { name: 'test' },
      makeTickView([
        withSlot(HERO, { ability: ZONE, phase: -1 }),
        // У противника каст ИДЁТ, и статы у него те же — но сэмпл не его.
        withSlot(ENEMY, { ability: ZONE, phase: 0 }, { prevX: 8, currX: 8 }),
      ]),
    );
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(8), y: F(0) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(0);
  });

  it('сэмпл снят — превью гаснет целиком', () => {
    const rig = makeRig();
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(1);

    rig.preview.applyLocalInput(null);
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(0);
  });

  it('свой игрок ещё не доставлен — рисовать не для кого', () => {
    const rig = makeRig();
    rig.stage.publish({ name: 'test' }, makeTickView([]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(0);
  });

  it('каст идёт во втором слоте — превью находит его тем же обходом', () => {
    const rig = makeRig();
    const hero = withSlot(HERO, { slot: 1, ability: ZONE, phase: 0 });
    rig.stage.publish({ name: 'test' }, makeTickView([hero]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(3), y: F(4) } });
    rig.stage.frame(0.016, 1);
    expect(rig.preview.shapeCount).toBe(1);
    expect(shapes(rig.scene)[0]!.position.x).toBeCloseTo(3, 6);
  });
});

// ------------------ RDBG-1: отладочный источник цепочки (REND-27, RDBG-2..8)

/** Секция дампа этого источника: читается ровно то, что кладёт проба. */
interface PreviewSection {
  readonly casting: boolean;
  readonly abilityId: string;
  readonly slotIndex: number;
  readonly slotCount: number;
  readonly ownerEntity: number;
  readonly ownerDelivered: boolean;
  readonly stepCount: number;
  readonly stagedSteps: number;
  readonly currentStepIndex: number;
  readonly currentStepKind: string;
  readonly currentStepDrawable: boolean;
  readonly aiming: boolean;
  readonly aimWorldX: number | null;
  readonly aimWorldY: number | null;
  readonly shapeCount: number;
  readonly objectCount: number;
  readonly noData?: string;
}

const PREVIEW_SOURCE = 'abilityPreview.chain';

function section(layer: RenderDebugLayer): PreviewSection {
  return layer.dump().sections[PREVIEW_SOURCE] as PreviewSection;
}

describe('Отладочный источник превью каста (render-debug RDBG-1, REND-27)', () => {
  it('источник объявлен подсистемой в точке её регистрации', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    expect(layer.sources.map((source) => source.id)).toEqual([PREVIEW_SOURCE]);
    expect(layer.sources[0]?.owner).toBe('abilityPreview');
    // Рисовальщик есть: отметка прицела — то, чего в кадре не видно иначе.
    expect(layer.sources[0]?.drawable).toBe(true);
  });

  it('выключенный источник секции в дампе не имеет, и слой не работает вовсе', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    // «Выключено» — это ОТСУТСТВИЕ секции, а не секция «данных нет» (RDBG-7).
    expect(layer.dump().sections).toEqual({});
    expect(layer.frameCount).toBe(0);
  });

  it('включённый источник называет идущий каст, текущий шаг и точку прицела', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    const hero = withSlot(
      HERO,
      { ability: GRAB, phase: 1, staged: 1, steps: [{ x: 9, y: 9, entity: VICTIM }] },
      { prevX: 1, currX: 1, prevY: 0, currY: 0 },
    );
    const victim = makeEntityView(VICTIM, { prevX: 4, currX: 4, prevY: 0, currY: 0 });
    rig.stage.publish({ name: 'test' }, makeTickView([hero, victim]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(1), y: F(8) } });
    rig.stage.frame(0.016, 1);

    const dumped = section(layer);
    expect(dumped.noData).toBeUndefined();
    expect(dumped.casting).toBe(true);
    expect(dumped.abilityId).toBe('grab');
    expect(dumped.slotIndex).toBe(0);
    expect(dumped.ownerEntity).toBe(HERO);
    expect(dumped.ownerDelivered).toBe(true);
    expect(dumped.stepCount).toBe(2);
    expect(dumped.stagedSteps).toBe(1);
    // Шаг, который игрок двигает сейчас, — второй, и он вектор (ABIL-5).
    expect(dumped.currentStepIndex).toBe(1);
    expect(dumped.currentStepKind).toBe('vector');
    expect(dumped.currentStepDrawable).toBe(true);
    expect(dumped.aiming).toBe(true);
    expect(dumped.aimWorldX).toBeCloseTo(1, 6);
    expect(dumped.aimWorldY).toBeCloseTo(8, 6);
    // Дамп описывает ТОТ ЖЕ кадр: контуров в нём столько же, сколько в сцене.
    expect(dumped.shapeCount).toBe(rig.preview.shapeCount);
    expect(dumped.objectCount).toBe(rig.preview.objectCount);
  });

  it('каста нет — данные есть и говорят это, а не молчат', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: -1 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: null });
    rig.stage.frame(0.016, 1);

    const dumped = section(layer);
    expect(dumped.noData).toBeUndefined();
    expect(dumped.casting).toBe(false);
    expect(dumped.abilityId).toBe('');
    expect(dumped.currentStepIndex).toBe(-1);
    expect(dumped.currentStepKind).toBe('none');
    // Точки нет — это null, а не ноль: ноль был бы координатой (RDBG-7).
    expect(dumped.aimWorldX).toBeNull();
    expect(dumped.aimWorldY).toBeNull();
    expect(dumped.shapeCount).toBe(0);
  });

  it('прошлый каст за идущий не принимается: запись активного слота переживает кадр', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    expect(section(layer).abilityId).toBe('zone');

    // Фаза кончилась (ABIL-1): следующий кадр обязан сказать «каста нет».
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: -1 })]));
    rig.stage.frame(0.016, 1);
    expect(section(layer).casting).toBe(false);
    expect(section(layer).abilityId).toBe('');
  });

  it('вычисляемый размер фигуры виден в дампе как «нерисуемо», а не молчанием', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: SCALED, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(3), y: F(3) } });
    rig.stage.frame(0.016, 1);

    const dumped = section(layer);
    // Каст идёт, шаг есть, а фигуры в кадре нет — и дамп называет причину
    // (REND-28): размер шага не литерал, вычислить его рендеру нечем.
    expect(dumped.casting).toBe(true);
    expect(dumped.currentStepIndex).toBe(0);
    expect(dumped.currentStepDrawable).toBe(false);
    expect(dumped.shapeCount).toBe(0);
  });

  it('сборка не объявила состояния слотов — источник говорит «нет данных» (RDBG-6)', () => {
    const rig = makeRig([]);
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    expect(section(layer).noData).toMatch(/состояние слотов/);
  });

  it('снятая секция дампа не меняется от следующего кадра', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    const before = section(layer);
    const snapshot = JSON.stringify(before);

    // Проба ПЕРЕИСПОЛЬЗУЕТСЯ между кадрами (RDBG-2), и дамп, державший её
    // ссылкой, менялся бы задним числом от следующего сэмпла.
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(-5), y: F(7) } });
    rig.stage.frame(0.016, 1);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(section(layer).aimWorldX).toBeCloseTo(-5, 6);
  });

  it('два дампа на одном доставленном состоянии совпадают: часовых величин у источника нет', () => {
    const rig = makeRig();
    const layer = new RenderDebugLayer(rig.stage);
    layer.setEnabled(PREVIEW_SOURCE, true);
    rig.stage.publish({ name: 'test' }, makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })]));
    rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(2) } });
    rig.stage.frame(0.016, 1);
    const first = layer.dump();
    const second = layer.dump();
    expect(second.sections).toEqual(first.sections);
    expect(Object.keys(first.clock).some((key) => key.startsWith(`${PREVIEW_SOURCE}.`))).toBe(false);
  });

  it('счётчики кадра с включённым источником и без него совпадают побитово (RDBG-8)', () => {
    const run = (debug: boolean): Record<string, number> => {
      const counters = createCostCounters();
      withCostSink(counters, () => {
        const rig = makeRig();
        const layer = new RenderDebugLayer(rig.stage);
        if (debug) layer.setEnabled(PREVIEW_SOURCE, true);
        rig.preview.applyLocalInput({ entity: HERO, target: { x: F(2), y: F(3) } });
        for (let tick = 1; tick <= 8; tick += 1) {
          rig.stage.publish(
            { name: 'test' },
            makeTickView([withSlot(HERO, { ability: ZONE, phase: 0 })], { tick }),
          );
          rig.stage.frame(1 / 60, 0.5, 1 / 60);
        }
      });
      return { ...counters };
    };
    const withDebug = run(true);
    const without = run(false);
    expect(withDebug).toEqual(without);
    // И проверялось не отсутствие работы: счётчики непустые.
    expect(without.syncTickSubsystems).toBeGreaterThan(0);
  });
});
