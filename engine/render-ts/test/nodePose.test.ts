/**
 * Поза названного узла инстанса (REND-20, REND-24): у ДВУХ ярусов ответ обязан
 * быть один. У детального узел лежит в скелете, у батчевого скелета нет вовсе —
 * поза кости берётся выборкой из VAT (ASSET-12) на CPU, теми же двумя строками
 * и тем же весом, какими смешивает шейдер.
 *
 * Ради этого требование и правится: сокет эмиттера (ASSET-14) наблюдаем в
 * кадре, а REND-20 требует совпадения ярусов по наблюдаемому — «сокет работает
 * только у детального» было бы различием, которого он не допускает.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VisualManifest } from '@fluxus/assets';
import { ModelsSubsystem, type NodePose, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';
const SOCKET = 'Bone_Chest';

/**
 * Две записи на одной модели: одна батчевая по умолчанию, другая с явным
 * детальным ярусом (ASSET-13). Анимаций нет ни у одной — обе стоят в позе
 * покоя, и сравнивать есть что.
 */
function makeManifest(): VisualManifest {
  return {
    entities: {
      Runner: { model: MODEL_ID, scale: 1 },
      Keeper: { model: MODEL_ID, scale: 1, tier: 'detailed' },
    },
  };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly assets: AssetsStub;
}

function makeRig(): Rig {
  const assets = makeAssets();
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(makeManifest(), { warn: () => {} });
  subsystem.init(ctx);
  return { subsystem, assets };
}

function pose(): NodePose {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

describe('ModelsSubsystem.nodePose (REND-20 → REND-24)', () => {
  /** Два инстанса в одной точке: батчевый (1) и детальный (2). */
  function place(rig: Rig, x = 3): void {
    rig.subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Runner', prevX: x, currX: x }),
        makeEntityView(2, { kind: 'Keeper', prevX: x, currX: x }),
      ]),
    );
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.subsystem.updateFrame(1 / 60, 1);
  }

  it('оба яруса дают одну позу узла', () => {
    const rig = makeRig();
    place(rig);
    expect(rig.subsystem.instanceFor(1)!.tier).toBe('batched');
    expect(rig.subsystem.instanceFor(2)!.tier).toBe('detailed');

    const batched = pose();
    const detailed = pose();
    expect(rig.subsystem.nodePose(1, SOCKET, batched)).toBe(true);
    expect(rig.subsystem.nodePose(2, SOCKET, detailed)).toBe(true);

    // Один и тот же узел одной и той же модели в одной и той же точке: ответы
    // ярусов совпадают, иначе эмиттер прыгал бы при смене яруса (QUAL-1).
    expect(batched.x).toBeCloseTo(detailed.x, 5);
    expect(batched.y).toBeCloseTo(detailed.y, 5);
    expect(batched.z).toBeCloseTo(detailed.z, 5);
    // И это не поза сущности: кость смещена от корня инстанса (фикстура —
    // `Bone_Chest` на +10 по X от корня, нормализованного по высоте модели).
    expect(batched.x).not.toBeCloseTo(3, 3);
  });

  it('поза узла едет вместе с инстансом', () => {
    const rig = makeRig();
    place(rig, 0);
    const first = pose();
    expect(rig.subsystem.nodePose(1, SOCKET, first)).toBe(true);

    rig.subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Runner', prevX: 5, currX: 5, snap: true }),
        makeEntityView(2, { kind: 'Keeper', prevX: 5, currX: 5, snap: true }),
      ]),
    );
    rig.subsystem.updateFrame(1 / 60, 1);

    const moved = pose();
    const detailed = pose();
    expect(rig.subsystem.nodePose(1, SOCKET, moved)).toBe(true);
    expect(rig.subsystem.nodePose(2, SOCKET, detailed)).toBe(true);
    expect(moved.x - first.x).toBeCloseTo(5, 5);
    expect(moved.x).toBeCloseTo(detailed.x, 5);
  });

  it('узла с таким именем нет — ответа тоже нет', () => {
    const rig = makeRig();
    place(rig);
    expect(rig.subsystem.nodePose(1, 'Bone_Tail', pose())).toBe(false);
    expect(rig.subsystem.nodePose(2, 'Bone_Tail', pose())).toBe(false);
  });

  it('инстанса нет или модель ещё едет — ответа нет, и это не ошибка', () => {
    const rig = makeRig();
    expect(rig.subsystem.nodePose(1, SOCKET, pose())).toBe(false); // инстанса нет
    rig.subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Runner' })]));
    // Модель ещё грузится (ASSET-4): узла пока нет, но он появится.
    expect(rig.subsystem.nodePose(1, SOCKET, pose())).toBe(false);
    rig.assets.resolve('model', MODEL_ID, makeModel());
    rig.subsystem.updateFrame(1 / 60, 1);
    expect(rig.subsystem.nodePose(1, SOCKET, pose())).toBe(true);
  });
});
