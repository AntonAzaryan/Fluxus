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
