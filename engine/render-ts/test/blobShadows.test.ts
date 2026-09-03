/**
 * Контактные пятна режима `blob` на РЕЛЬЕФЕ (`rendering` REND-30): их опора и
 * их прилегание к поверхности.
 *
 * Соседний файл (`lighting.test.ts`) держит режим целиком — реестр носителей,
 * состав кадра, потолки пресета; здесь под тестом ровно две величины, которые
 * на ровной арене неотличимы от позы инстанса и потому там не видны:
 *
 * - высота пятна у ЛЕТЯЩЕГО инстанса: поза уходит вверх дугой манёвра и вниз
 *   снижением при провале (REND-12), а пятно обязано остаться на опоре — иначе
 *   оно взлетает вместе с моделью и перестаёт быть тем, ради чего режим и заведён;
 * - ориентация пятна на СКЛОНЕ: горизонтальный круг на уклоне рампы (шаг высоты
 *   на клетку, ≈31°) уходит в грунт на половину своего радиуса.
 *
 * Арена стенда — цепочка рамп (TERR-5): каждая клетка поднимается на шаг
 * высоты, поле выходит РОВНОЙ наклонной плоскостью, и «пятно не режется
 * грунтом» становится точным утверждением, а не приблизительным.
 *
 * Всё headless: инстанс-матрицы — данные, и то, что квад лёг плашмя на склон,
 * читается из них так же точно, как из картинки.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, LOCOMOTION_AIRBORNE, createTerrainGrid, type EntityId } from '@fluxus/core';
import type { VisualManifest } from '@fluxus/assets';
import {
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  VisualSurfaceSource,
  type PresentationProducer,
  type RenderContext,
  type SurfaceNormal,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
const HERO: EntityId = 1;
const PRODUCER: PresentationProducer = { name: 'test' };

/**
 * Шаг высоты стенда — он же перепад рампы на клетку. Клетка равна мировой
 * единице (`tileSize` = FIXED_ONE), поэтому уклон склона — atan(0.6) ≈ 31°:
 * ровно та рампа, о которой идёт речь.
 */
const HEIGHT_STEP = 0.6;

/** Подъём пятна над опорой (`lighting/blobShadows.ts`) — вдоль нормали опоры. */
const LIFT = 0.02;

/** Точка стенда: середина склона, куда ни одна кромка пятна не выходит за него. */
const AT_X = 3.5;
const AT_Y = 2;

/**
 * Склон в 31°: восемь клеток, каждая на уровень выше предыдущей и помечена
 * рампой. Цепочка рамп смыкается узлами (REND-9), поэтому поверхность выходит
 * непрерывной плоскостью `z = 0.6 · x` — без ступеней и без сглаживания внутри
 * клетки, которое даёт карта кривизны.
 */
function rampGrid(ramps: boolean) {
  return createTerrainGrid({
    width: 8,
    height: 4,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: 4 }, () => (ramps ? '01234567' : '00000000')),
    flags: Array.from({ length: 4 }, () => (ramps ? '^^^^^^^^' : '........')),
  });
}

function makeManifest(): VisualManifest {
  return {
    entities: {
      // Дуга прыжка и глубина провала заметно больше подъёма пятна: поедь пятно
      // с позой, разница мерялась бы метрами, а не долями миллиметра.
      Runner: {
        model: MODEL_ID,
        scale: 1,
        verticalOffset: { jumpArc: 2, fallSpeed: 6, fallDepth: 3 },
      },
    },
  };
}

interface Rig {
  readonly stage: PresentationStage;
  readonly lighting: LightingSubsystem;
  readonly models: ModelsSubsystem;
  readonly surface: VisualSurfaceSource;
}

/** Сцена подсистем в порядке сборок (REND-8): свет, следом владелец инстансов. */
function makeRig(ramps = true): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: HEIGHT_STEP },
  };
  const stage = new PresentationStage(ctx);
  const grid = rampGrid(ramps);
  const lighting = new LightingSubsystem({ grid, config: { shadows: { mode: 'blob' } } });
  stage.register(lighting);
  const surface = new VisualSurfaceSource(grid);
  const models = new ModelsSubsystem(makeManifest(), {
    surface,
    shadows: lighting,
    warn: () => {},
  });
  stage.register(models);
  assets.resolve('model', MODEL_ID, makeModel());
  return { stage, lighting, models, surface };
}

/** Доставка одного инстанса стенда: место одно, различаются только манёвры. */
function standing(partial: Parameters<typeof makeEntityView>[1] = {}) {
  return makeEntityView(HERO, {
    prevX: AT_X,
    currX: AT_X,
    prevY: AT_Y,
    currY: AT_Y,
    ...partial,
  });
}

/** Разобранная матрица единственного пятна кадра. */
function blob(rig: Rig): {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  readonly diameter: number;
  readonly matrix: THREE.Matrix4;
} {
  const mesh = rig.lighting.blobShadows;
  expect(mesh, 'меш пятен обязан быть в сцене').not.toBeNull();
  expect(mesh!.count, 'пятно кадра обязано быть ровно одно').toBe(1);
  const matrix = new THREE.Matrix4();
  mesh!.getMatrixAt(0, matrix);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, quaternion, diameter: scale.x, matrix };
}

/** Нормаль поверхности в мировой точке. */
function surfaceNormal(rig: Rig, x: number, y: number): THREE.Vector3 {
  const out: SurfaceNormal = { x: 0, y: 0, z: 1 };
  rig.surface.current!.normalAt(x, y, out);
  return new THREE.Vector3(out.x, out.y, out.z);
}

describe('контактное пятно на рельефе (REND-30)', () => {
  it('склон стенда — тот самый уклон в 31°, а не пологий бугор', () => {
    // Фикстура обязана быть тем случаем, о котором идёт речь: шаг высоты на
    // клетку. Иначе всё ниже проверяло бы почти горизонтальную поверхность.
    const rig = makeRig();
    const angle = Math.acos(surfaceNormal(rig, AT_X, AT_Y).z);
    expect((angle * 180) / Math.PI).toBeCloseTo(30.96, 1);
    // И поверхность действительно плоская: высота линейна по X на всём склоне.
    const surface = rig.surface.current!;
    for (const x of [1, 2.5, 3.5, 5, 6.5]) {
      expect(surface.heightAt(x, AT_Y)).toBeCloseTo(HEIGHT_STEP * x, 5);
    }
  });

  it('летящий инстанс: пятно остаётся на опоре, а не взлетает с моделью (REND-12)', () => {
    const rig = makeRig();
    rig.stage.publish(
      PRODUCER,
      makeTickView([
        standing({
          motion: LOCOMOTION_AIRBORNE,
          prevMotionPhase: 0.5,
          currMotionPhase: 0.5,
        }),
      ]),
    );
    rig.stage.frame(0.016, 1);

    const seat = rig.surface.current!.heightAt(AT_X, AT_Y);
    const normal = surfaceNormal(rig, AT_X, AT_Y);
    // Сам инстанс поднят дугой манёвра: её вершина — 4·0.5·0.5·2 = 2 (REND-12).
    expect(rig.models.instanceFor(HERO)!.pose.z).toBeCloseTo(seat + 2, 5);

    // А пятно — на опоре плюс подъём вдоль нормали, и только.
    const { position } = blob(rig);
    expect(position.z).toBeCloseTo(seat + LIFT * normal.z, 5);
    expect(position.x).toBeCloseTo(AT_X + LIFT * normal.x, 5);
  });

  it('снижение при провале пятна не опускает: опора остаётся поверхностью (ARENA-5)', () => {
    // Зеркало предыдущего случая с другой стороны: `fallOffset` уводит позу ВНИЗ,
    // под землю, и пятно, взятое с позы, ушло бы под поверхность вместе с ней.
    const rig = makeRig();
    rig.stage.publish(PRODUCER, makeTickView([standing()]));
    rig.stage.frame(0.016, 1);
    const before = blob(rig).position.z;

    rig.stage.publish(
      PRODUCER,
      makeTickView([standing()], {
        freshEvents: true,
        events: [{ type: 'FellThroughFloor', data: { entity: HERO } }],
      }),
    );
    rig.stage.frame(0.2, 1);

    expect(rig.models.instanceFor(HERO)!.pose.z).toBeLessThan(before - 1);
    expect(blob(rig).position.z).toBeCloseTo(before, 6);
  });

  it('на склоне квад лежит плашмя: его нормаль — нормаль опоры (REND-30)', () => {
    const rig = makeRig();
    rig.stage.publish(PRODUCER, makeTickView([standing()]));
    rig.stage.frame(0.016, 1);

    const quadNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(blob(rig).quaternion);
    const normal = surfaceNormal(rig, AT_X, AT_Y);

    expect(normal.z).toBeLessThan(0.9); // склон действительно крутой
    expect(quadNormal.x).toBeCloseTo(normal.x, 5);
    expect(quadNormal.y).toBeCloseTo(normal.y, 5);
    expect(quadNormal.z).toBeCloseTo(normal.z, 5);
  });

  it('на склоне пятно не режется грунтом: обе кромки над поверхностью', () => {
    // Тот же дефект с геометрической стороны — той, которой он и виден:
    // горизонтальный круг радиуса r на уклоне θ уходит в грунт уже на расстоянии
    // `подъём / tg θ` от центра, то есть на рампе прячется примерно половина
    // пятна. `polygonOffset` материала тут бессилен: он двигает глубину
    // ко-планарных фрагментов, а не спасает от геометрического пересечения.
    const rig = makeRig();
    rig.stage.publish(PRODUCER, makeTickView([standing()]));
    rig.stage.frame(0.016, 1);

    const { matrix, diameter } = blob(rig);
    expect(diameter).toBeGreaterThan(0.2); // след фикстурной модели ненулевой
    const surface = rig.surface.current!;
    // Кромки квада вдоль его локальной оси X — направление наибольшего уклона.
    for (const at of [-0.5, 0.5]) {
      const rim = new THREE.Vector3(at, 0, 0).applyMatrix4(matrix);
      const under = surface.heightAt(rim.x, rim.y);
      expect(rim.z - under, `кромка ${at > 0 ? 'вверх' : 'вниз'} по склону`).toBeGreaterThan(0);
    }
  });

  it('на ровной арене пятно лежит горизонтально — наклонять его не по чему', () => {
    const rig = makeRig(false);
    rig.stage.publish(PRODUCER, makeTickView([standing()]));
    rig.stage.frame(0.016, 1);

    const { position, quaternion } = blob(rig);
    expect(new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).z).toBeCloseTo(1, 6);
    expect(position.z).toBeCloseTo(LIFT, 6);
  });
});
