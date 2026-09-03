/**
 * Подсистема моделей: пул инстансов по снапшоту (REND-3), заглушки на время
 * загрузки и при отсутствии записи в манифесте (ASSET-4, ASSET-6), скины
 * пер-инстанс (REND-6), смерть по событию (REND-4), интерполяция позиции.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  ModelsSubsystem,
  wrapAngle,
  type BlobCaster,
  type LightingSink,
  type RenderContext,
} from '../src/index.js';
import { modelDerivatives, type VisualManifest } from '@fluxus/assets';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

function makeManifest(): VisualManifest {
  return {
    entities: {
      Runner: {
        model: MODEL_ID,
        scale: 1,
        defaultSkin: 'red',
        skins: {
          red: { '0': 'tex/red.png' },
          blue: { '0': 'tex/blue.png' },
        },
        animations: {
          states: { idle: 'Stand', move: 'Walk' },
          events: { CastFireball: 'Attack', EntityDied: 'Death' },
        },
        boneControls: {
          torso: { bone: 'Bone_Chest', maxYawDeg: 72, smoothing: 18 },
        },
      },
    },
  };
}

/** Тот же манифест без выбранного скина по умолчанию: подмен слотов нет. */
function plainManifest(): VisualManifest {
  const manifest = makeManifest();
  delete manifest.entities.Runner!.defaultSkin;
  return manifest;
}

function makeRig(
  manifest: VisualManifest = makeManifest(),
  options: {
    readonly reviveEvent?: string;
    readonly fadeSeconds?: number;
    readonly stateComponents?: readonly string[];
    readonly deadState?: string;
    readonly shadows?: LightingSink;
  } = {},
): {
  subsystem: ModelsSubsystem;
  ctx: RenderContext;
  assets: AssetsStub;
  warnings: string[];
} {
  const assets = makeAssets();
  const warnings: string[] = [];
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(manifest, {
    ...options,
    warn: (message) => warnings.push(message),
  });
  subsystem.init(ctx);
  return { subsystem, ctx, assets, warnings };
}

describe('пул инстансов по снапшоту (REND-3)', () => {
  it('появление сущности создаёт инстанс (сначала заглушку), исчезновение — убирает', () => {
    const { subsystem, ctx, assets } = makeRig();

    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(ctx.scene.children.length).toBe(1); // сценовый объект сущности
    expect(assets.requests).toContainEqual({ kind: 'model', id: MODEL_ID });
    expect(subsystem.instanceFor(1)!.placeholder).toBe(true); // на время загрузки (ASSET-4)
    expect(subsystem.instanceFor(1)!.model).toBeNull();

    subsystem.syncTick(makeTickView([])); // сущность исчезла
    expect(subsystem.instanceFor(1)).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });

  it('готовый ассет подменяет заглушку; геометрия разделяется между инстансами', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    // Одна модель — один запрос ассета на двоих (ASSET-2 на стороне рендера).
    expect(assets.requests.filter((request) => request.kind === 'model').length).toBe(1);

    assets.resolve('model', MODEL_ID, makeModel());
    const a = subsystem.instanceFor(1)!.model!;
    const b = subsystem.instanceFor(2)!.model!;
    expect(a).not.toBeNull();
    expect(a.meshes[0]!.geometry).toBe(b.meshes[0]!.geometry); // общие буферы
    expect(a.skeleton).not.toBe(b.skeleton); // скелет свой на инстанс
    // Записи с подменой слота скином: материалы у инстансов свои (REND-6).
    expect(a.materials[0]).not.toBe(b.materials[0]);
  });

  it('сущность без записи в манифесте — заглушка и предупреждение один раз (ASSET-6)', () => {
    const { subsystem, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' })]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Ghost' }), makeEntityView(2, { kind: 'Ghost' })]));
    expect(warnings.filter((message) => message.includes('Ghost')).length).toBe(1);
    expect(subsystem.instanceFor(1)!.placeholder).toBe(true);
    expect(subsystem.instanceFor(1)!.model).toBeNull();
  });

  it('kind === null — сущность не рисуется и не шумит', () => {
    const { subsystem, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: null })]));
    const instance = subsystem.instanceFor(1)!;
    expect(instance.placeholder).toBe(false);
    expect(instance.model).toBeNull();
    expect(instance.bounds).toBeNull(); // рисовать нечего — и попадать не во что
    expect(warnings.length).toBe(0);
  });
});

describe('скины пер-инстанс (REND-6)', () => {
  it('скин по умолчанию запрашивает подмену слота; смена скина не трогает соседа', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());

    // defaultSkin 'red': подмена слота 0 перекрывает базовый путь модели.
    const redRequests = assets.requests.filter((request) => request.id === 'tex/red.png');
    expect(redRequests.length).toBe(2); // по одному на инстанс
    expect(assets.requests.some((request) => request.id === 'tex/base.png')).toBe(false);

    subsystem.setSkin(1, 'blue');
    const blueRequests = assets.requests.filter((request) => request.id === 'tex/blue.png');
    expect(blueRequests.length).toBe(1); // только перекрашенный инстанс
  });

  it('материалы разделяются до подмены скина и копируются на ней (REND-3, REND-6)', () => {
    const { subsystem, assets } = makeRig(plainManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const a = subsystem.instanceFor(1)!.model!;
    const b = subsystem.instanceFor(2)!.model!;
    // Записи без скинов: инстансы от ассета не отличаются ничем.
    expect(a.ownsMaterials).toBe(false);
    expect(a.materials[0]).toBe(b.materials[0]);
    expect(a.meshes[0]!.material).toBe(b.meshes[0]!.material);

    // Первая подмена — и только у того, кому подменили: copy-on-write.
    subsystem.setSkin(1, 'blue');
    expect(a.ownsMaterials).toBe(true);
    expect(b.ownsMaterials).toBe(false);
    expect(a.materials[0]).not.toBe(b.materials[0]);
    expect(a.meshes[0]!.material).not.toBe(b.meshes[0]!.material);
  });
});

describe('анимации по данным тика (REND-4)', () => {
  it('idle/move из скорости и one-shot по событию каста', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.currentClipName).toBe('Stand - 1');

    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    expect(controller.currentClipName).toBe('Walk Fast');

    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], {
        freshEvents: true,
        events: [{ type: 'CastFireball', data: { entity: 1 } }],
      }),
    );
    expect(controller.currentClipName).toBe('Attack - 1');
  });

  it('EntityDied — смерть с фиксацией кадра; на replay события не переигрываются (OBS-5)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;

    // Replay-тик: freshEvents false — событие игнорируется.
    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: false,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(controller.isDead).toBe(false);

    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });

  /**
   * Возрождение (REND-4) на детальном ярусе. Наблюдаемое здесь не только имя
   * клипа: у модели с распадающимся трупом клип смерти к своему концу ГАСИТ
   * геосеты тела (`assets` ASSET-12 → трек видимости частей), и зафиксированный
   * последний кадр рисует пустое место. Именно это и видел игрок: живой,
   * управляемый и невидимый герой.
   */
  describe('возрождение возвращает модель (REND-4)', () => {
    /**
     * Модель, чей клип смерти гасит часть 0 и держит её погашенной до конца —
     * ровно так устроена смерть `SkeletonBarbarian` в `content/visuals`: у неё
     * последний кадр `Death` не рисует НИ ОДНОГО геосета.
     */
    function decayingModel(): ReturnType<typeof makeModel> {
      const base = makeModel();
      const track = (partId: number, times: number[], visible: number[]) => ({
        partId,
        times: new Float32Array(times),
        visible: new Uint8Array(visible),
      });
      const shown = (name: string, duration: number) => ({
        ...base.sequences.find((sequence) => sequence.name === name)!,
        partVisibility: [track(0, [0, duration], [1, 1])],
      });
      return {
        ...base,
        sequences: [
          shown('Stand - 1', 1),
          shown('Walk Fast', 1),
          base.sequences[2]!,
          {
            ...base.sequences.find((sequence) => sequence.name === 'Death')!,
            // Тело гаснет на середине клипа и остаётся погашенным: клип
            // фиксируется последним кадром, а на нём рисовать уже нечего.
            partVisibility: [track(0, [0, 0.4, 0.8], [1, 0, 0])],
          },
        ],
      };
    }

    /** Видима ли часть 0 инстанса в кадре — то, что рисуется (или не рисуется). */
    function partVisible(subsystem: ModelsSubsystem, entity: number): boolean {
      const model = subsystem.instanceFor(entity)!.model!;
      return model.meshes.find((mesh) => mesh.name === 'part0')!.visible;
    }

    /** Тик, где `entity` из набора `pool` получает событие `type`. */
    function event(
      subsystem: ModelsSubsystem,
      pool: readonly number[],
      type: string,
      entity: number,
    ): void {
      subsystem.syncTick(
        makeTickView(
          pool.map((id) => makeEntityView(id, { moving: true })),
          { freshEvents: true, events: [{ type, data: { entity } }] },
        ),
      );
    }

    it('зафиксированный кадр смерти не рисует ничего, возрождение возвращает клип и геосеты', () => {
      const { subsystem, assets } = makeRig(makeManifest(), { reviveEvent: 'HeroRespawned' });
      subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
      assets.resolve('model', MODEL_ID, decayingModel());
      const controller = subsystem.instanceFor(1)!.controller!;
      for (let i = 0; i < 30; i++) subsystem.updateFrame(1 / 60, 1);
      expect(controller.currentClipName).toBe('Walk Fast');
      expect(partVisible(subsystem, 1)).toBe(true);

      event(subsystem, [1], 'EntityDied', 1);
      for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
      // Клип смерти доигран и зафиксирован — и рисовать в этом кадре нечего.
      expect(controller.isDead).toBe(true);
      expect(controller.currentClipName).toBe('Death');
      expect(partVisible(subsystem, 1)).toBe(false);

      // Сцена вернула ТУ ЖЕ сущность: снапа нет, `snapAll` не поднимался.
      event(subsystem, [1], 'HeroRespawned', 1);
      for (let i = 0; i < 30; i++) subsystem.updateFrame(1 / 60, 1);

      expect(controller.isDead).toBe(false);
      expect(controller.currentClipName).toBe('Walk Fast');
      expect(partVisible(subsystem, 1)).toBe(true);
    });

    it('возрождение чужой сущности соседа не поднимает', () => {
      const { subsystem, assets } = makeRig(makeManifest(), { reviveEvent: 'HeroRespawned' });
      subsystem.syncTick(
        makeTickView([makeEntityView(1, { moving: true }), makeEntityView(2, { moving: true })]),
      );
      assets.resolve('model', MODEL_ID, decayingModel());
      event(subsystem, [1, 2], 'EntityDied', 1);
      event(subsystem, [1, 2], 'EntityDied', 2);
      for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);

      event(subsystem, [1, 2], 'HeroRespawned', 2);
      for (let i = 0; i < 30; i++) subsystem.updateFrame(1 / 60, 1);

      expect(subsystem.instanceFor(2)!.controller!.isDead).toBe(false);
      expect(partVisible(subsystem, 2)).toBe(true);
      // Первый труп событию соседа не адресован — он лежит дальше.
      expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(true);
      expect(partVisible(subsystem, 1)).toBe(false);
    });
  });

  it('неразрешённая запись манифеста жалуется в сток подсистемы и оставляет клип (REND-4)', () => {
    const manifest: VisualManifest = {
      entities: {
        // Клипа «Wolk» в модели нет: опечатка автора манифеста.
        Runner: { model: MODEL_ID, animations: { states: { idle: 'Stand', move: 'Wolk' } } },
      },
    };
    const { subsystem, assets, warnings } = makeRig(manifest);
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.currentClipName).toBe('Stand - 1');

    // Каждый тик зовёт setState — предупреждение остаётся одним на запись.
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    expect(controller.currentClipName).toBe('Stand - 1');
    expect(warnings.filter((message) => message.includes('Wolk')).length).toBe(1);
  });
});

describe('покадровое обновление (REND-2, REND-5)', () => {
  it('позиция интерполируется по альфе, уровень поднимает на heightStep', () => {
    const { subsystem } = makeRig();
    const view = makeEntityView(1, {
      prevX: 0,
      currX: 1,
      prevY: 0,
      currY: 0,
      prevLevel: 1,
      currLevel: 1,
    });
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(0.016, 0.5);
    const pose = subsystem.instanceFor(1)!.pose;
    expect(pose.x).toBeCloseTo(0.5, 6);
    expect(pose.z).toBeCloseTo(0.5, 6); // уровень 1 × heightStep 0.5

    // snap-тик рисуется без интерполяции.
    view.snap = true;
    view.prevX = 5;
    view.currX = 5;
    subsystem.syncTick(makeTickView([view]));
    subsystem.updateFrame(0.016, 0.25);
    expect(pose.x).toBeCloseTo(5, 6);
  });

  it('торс доворачивается к aimYaw после mixer.update (REND-5)', () => {
    const { subsystem, assets } = makeRig();
    const view = makeEntityView(1, { aimYaw: Math.PI / 2 });
    subsystem.syncTick(makeTickView([view]));
    assets.resolve('model', MODEL_ID, makeModel());

    const model = subsystem.instanceFor(1)!.model!;
    const chest = model.bonesByName.get('Bone_Chest')!;
    // Много кадров: сглаживание (smoothing 18) успевает довернуть до лимита.
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    const euler = new THREE.Euler().setFromQuaternion(chest.quaternion, 'ZYX');
    // Лимит манифеста 72°; клип Stand сам крутит кость, поэтому проверяем
    // только знак и заметность доворота, а не точный угол.
    expect(euler.z).toBeGreaterThan(0.3);
  });
});

describe('перёд модели — данные записи манифеста (REND-13)', () => {
  /**
   * Манифест с двумя записями на одну модель: перёд у них разный, как у моделей
   * разных форматов. Это и есть случай, ради которого перёд перестал быть одним
   * числом на подсистему: значения, верного для обеих записей сразу, не бывает.
   */
  function makeFacingRig(): { subsystem: ModelsSubsystem; ctx: RenderContext } {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const manifest: VisualManifest = {
      entities: {
        // Лицо вдоль +X — соглашение MDX, поправки не требует.
        Mdxish: { model: MODEL_ID, facingDeg: 0 },
        // Лицо вдоль −Y — так приезжает glTF-модель демо.
        Gltfish: { model: MODEL_ID, facingDeg: -90 },
        // Записи без поля разворачиваются по соглашению первого формата.
        Legacy: { model: MODEL_ID },
      },
    };
    const subsystem = new ModelsSubsystem(manifest, {});
    subsystem.init(ctx);
    return { subsystem, ctx };
  }

  it('две записи с разным передом развёрнуты каждая по-своему на одном курсе', () => {
    const { subsystem } = makeFacingRig();
    // Обе сущности держат ОДИН курс: расхождение разворота даёт только перёд.
    const heading = Math.PI / 4;
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Mdxish', facingYaw: heading }),
        makeEntityView(2, { kind: 'Gltfish', facingYaw: heading }),
        makeEntityView(3, { kind: 'Legacy', facingYaw: heading }),
      ]),
    );
    subsystem.updateFrame(1 / 60, 1); // snapPending: доворот мгновенный

    const yawOf = (id: number): number => subsystem.instanceFor(id)!.pose.yaw;
    expect(yawOf(1)).toBeCloseTo(heading, 6);
    // Лицо смотрит на −90°, значит инстанс доворачивается на +90°.
    expect(yawOf(2)).toBeCloseTo(heading + Math.PI / 2, 6);
    // Запись без поля ведёт себя как запись с передом вдоль +X.
    expect(yawOf(3)).toBeCloseTo(yawOf(1), 6);
  });

  it('перёд одной записи не влияет на инстансы другой', () => {
    const { subsystem } = makeFacingRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { kind: 'Mdxish', facingYaw: 0 }),
        makeEntityView(2, { kind: 'Gltfish', facingYaw: 0 }),
      ]),
    );
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.pose.yaw).toBeCloseTo(0, 6);
    expect(subsystem.instanceFor(2)!.pose.yaw).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('курс кадра — интерполяция пары доставленных тиков (REND-2)', () => {
  /**
   * Стенд без сглаживания доворота (`turnRate: 0` — `smoothYaw` возвращает
   * цель сразу): сглаживание живёт поверх интерполяции и про неё ничего не
   * знает, а проверяется здесь именно ЦЕЛЬ кадра. Перёд записи нулевой, чтобы
   * поправка REND-13 не смешивалась с курсом.
   */
  function makeYawRig(): ModelsSubsystem {
    const assets = makeAssets();
    const subsystem = new ModelsSubsystem(
      { entities: { Runner: { model: MODEL_ID, facingDeg: 0 } } },
      { turnRate: 0 },
    );
    subsystem.init({
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    });
    return subsystem;
  }

  it('на половине альфы курс — середина КРАТЧАЙШЕЙ дуги между доставками', () => {
    const subsystem = makeYawRig();
    // Пара курсов лежит по разные стороны от ±π: короткая дуга между 3 и −3
    // идёт ЧЕРЕЗ π длиной 2π−6 ≈ 0.283, длинная — через ноль длиной 6.
    const prev = 3;
    const curr = -3;
    // Первая доставка схлопывает пару: инстанс встаёт на курс мгновенно.
    subsystem.syncTick(makeTickView([makeEntityView(1, { prevFacingYaw: prev, facingYaw: prev })]));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.pose.yaw).toBeCloseTo(prev, 6);

    // Вторая доставка развернула сущность; кадр рисуется на половине альфы.
    subsystem.syncTick(makeTickView([makeEntityView(1, { prevFacingYaw: prev, facingYaw: curr })]));
    subsystem.updateFrame(1 / 60, 0.5);

    const yaw = subsystem.instanceFor(1)!.pose.yaw;
    expect(yaw).toBeCloseTo(Math.PI, 6);
    // Линейная середина пары — ноль: ровно та половина оборота в чужую
    // сторону, ради которой дуга и заворачивается.
    const linearMid = (prev + curr) / 2;
    expect(Math.abs(wrapAngle(yaw - linearMid))).toBeGreaterThan(3);
    // И это не конец пары: цель кадра — интерполированный курс, а не курс
    // последнего доставленного тика.
    expect(Math.abs(wrapAngle(yaw - curr))).toBeGreaterThan(0.1);
  });

  it('при snap кадр берёт курс последней доставки без интерполяции (REND-2)', () => {
    const subsystem = makeYawRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { prevFacingYaw: 0, facingYaw: 0 })]));
    subsystem.updateFrame(1 / 60, 1);
    // Телепорт: пара доставки ещё хранит прежний курс, но рисовать надо новый.
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { prevFacingYaw: 0, facingYaw: 1.2, snap: true })]),
    );
    subsystem.updateFrame(1 / 60, 0.5);
    expect(subsystem.instanceFor(1)!.pose.yaw).toBeCloseTo(1.2, 6);
  });
});

// -------------------------------------------------------------- отсечение

describe('отсечение невидимых инстансов (REND-21)', () => {
  /**
   * Камера смотрит вдоль +X из начала координат: всё, что позади неё по X,
   * заведомо вне пирамиды видимости. Матрицы считаются один раз — подсистема
   * читает их такими, какими кадр и будет нарисован.
   */
  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 1);
    camera.lookAt(10, 0, 1);
    camera.updateMatrixWorld(true);
    return camera;
  }

  function makeCullRig(
    camera?: THREE.PerspectiveCamera,
    cullMargin?: number,
  ): { subsystem: ModelsSubsystem; assets: AssetsStub } {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const subsystem = new ModelsSubsystem(makeManifest(), {
      warn: () => {},
      ...(camera === undefined ? {} : { camera }),
      ...(cullMargin === undefined ? {} : { cullMargin }),
    });
    subsystem.init(ctx);
    return { subsystem, assets };
  }

  /** Инстанс перед камерой и инстанс у неё за спиной. */
  function placePair(subsystem: ModelsSubsystem, assets: AssetsStub): void {
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { prevX: 10, currX: 10, prevY: 0, currY: 0 }),
        makeEntityView(2, { prevX: -10, currX: -10, prevY: 0, currY: 0 }),
      ]),
    );
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
  }

  it('инстанс вне пирамиды видимости гаснет, инстанс в кадре — нет', () => {
    const { subsystem, assets } = makeCullRig(makeCamera());
    placePair(subsystem, assets);
    expect(subsystem.instanceFor(1)!.visible).toBe(true);
    expect(subsystem.instanceFor(2)!.visible).toBe(false);
  });

  it('отсечённый инстанс остаётся в наборе и в прокси picking’а (REND-15)', () => {
    const { subsystem, assets } = makeCullRig(makeCamera());
    placePair(subsystem, assets);
    // Отсечение — стоимость кадра, а не состав набора: инстанс никуда не делся,
    // и объём-прокси у него прежний.
    const seen: number[] = [];
    subsystem.eachProxy((proxy) => seen.push(proxy.entity));
    expect(seen).toEqual([1, 2]);
    expect(subsystem.instanceFor(2)).not.toBeNull();
  });

  it('сборка без камеры отсечения не делает: кадр тот же, что до его появления', () => {
    const { subsystem, assets } = makeCullRig();
    placePair(subsystem, assets);
    expect(subsystem.instanceFor(1)!.visible).toBe(true);
    expect(subsystem.instanceFor(2)!.visible).toBe(true);
  });

  it('границы консервативны по клипам, а запас остаётся моделям без производных', () => {
    // Инстанс за краем пирамиды ровно настолько, что габариты bind-позы
    // кончаются снаружи: без консервативности выпад клипа у края экрана
    // исчезал бы раньше самого инстанса (REND-21).
    const edgeY = 10 * Math.tan((22.5 * Math.PI) / 180) + 0.4;
    const place = (
      subsystem: ModelsSubsystem,
      assets: AssetsStub,
      model = makeModel(),
    ): void => {
      subsystem.syncTick(
        makeTickView([makeEntityView(1, { prevX: 10, currX: 10, prevY: edgeY, currY: edgeY })]),
      );
      assets.resolve('model', MODEL_ID, model);
      subsystem.updateFrame(1 / 60, 1);
    };

    // Модель с запечёнными производными (ASSET-12): границы по всем кадрам всех
    // клипов консервативны сами по себе, и запас к ним не добавляется — нулевой
    // `cullMargin` инстанс не срезает.
    const baked = makeCullRig(makeCamera(), 0);
    place(baked.subsystem, baked.assets);
    expect(baked.subsystem.instanceFor(1)!.visible).toBe(true);

    // Модель без костей запечь нечем: у неё границы — bind-поза, и единственное,
    // чем выражена консервативность, остаётся запас.
    const boneless = { ...makeModel(), bones: [], sequences: [] };
    const generous = makeCullRig(makeCamera());
    place(generous.subsystem, generous.assets, boneless);
    expect(generous.subsystem.instanceFor(1)!.visible).toBe(true);

    const strict = makeCullRig(makeCamera(), 0);
    place(strict.subsystem, strict.assets, boneless);
    expect(strict.subsystem.instanceFor(1)!.visible).toBe(false);
  });
});

describe('FOW-8: fade «ушла в туман» отличается от смерти (design D7)', () => {
  const FADE = 0.5;

  /** Видимый масштаб инстанса: fade его больше НЕ трогает (FOW-8 — прозрачность). */
  function drawnScale(ctx: RenderContext): number {
    const holder = ctx.scene.children[0];
    if (holder === undefined) throw new Error('в сцене нет инстанса');
    return holder.scale.x;
  }

  /** Проявленность инстанса — прозрачность материала меша держателя (FOW-8). */
  function drawnOpacity(ctx: RenderContext): number {
    const holder = ctx.scene.children[0];
    if (holder === undefined) throw new Error('в сцене нет инстанса');
    let opacity = -1;
    holder.traverse((node) => {
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      if (mesh.isMesh !== true || mesh.material === undefined || opacity >= 0) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0]! : mesh.material;
      opacity = material.opacity;
    });
    if (opacity < 0) throw new Error('у инстанса нет меша');
    return opacity;
  }

  it('исчезновение без события смерти — fade-out: инстанс доживает до конца анимации', () => {
    const { subsystem, ctx } = makeRig(makeManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    // Доводим fade-in появления до конца: стартовое состояние — полная непрозрачность.
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBe(1);

    // Сущности больше нет в доставленном состоянии, события смерти не было.
    subsystem.syncTick(makeTickView([]));
    expect(subsystem.instanceFor(1)).not.toBeNull(); // инстанс жив — угасает
    subsystem.updateFrame(1 / 60, 1);
    const early = drawnOpacity(ctx);
    expect(early).toBeLessThan(1);
    expect(early).toBeGreaterThan(0);
    // Угасание — прозрачностью, а не стягиванием: масштаб кадра не меняется.
    expect(drawnScale(ctx)).toBe(1);
    subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBeLessThan(early); // угасание монотонно

    // Полная длительность конфига прошла — инстанс снят штатным путём.
    for (let i = 0; i < Math.ceil(FADE * 60) + 2; i++) subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });

  it('появление — короткий fade-in: инстанс проявляется, а не мигает', () => {
    const { subsystem, ctx } = makeRig(makeManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(1 / 60, 1);
    const first = drawnOpacity(ctx);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
    expect(drawnScale(ctx)).toBe(1); // проявление тоже прозрачностью, не ростом
    subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBeGreaterThan(first);
    // Fade-in короче fade-out: за половину длительности проявление доиграло.
    for (let i = 0; i < Math.ceil((FADE / 2) * 60); i++) subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBe(1);
  });

  it('EntityDied того же тика — существующий путь смерти, без fade', () => {
    const { subsystem } = makeRig(makeManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    // Сущность исчезла И событие смерти доставлено: гибель, инстанс снят сразу.
    subsystem.syncTick(
      makeTickView([], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(subsystem.instanceFor(1)).toBeNull();
  });

  it('вернувшаяся из тумана сущность отменяет fade-out и проявляется обратно', () => {
    const { subsystem, ctx } = makeRig(makeManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);

    subsystem.syncTick(makeTickView([]));
    for (let i = 0; i < 6; i++) subsystem.updateFrame(1 / 60, 1);
    const faded = drawnOpacity(ctx);
    expect(faded).toBeLessThan(1);

    // Снова в доставленном состоянии: тот же инстанс, проявление от текущей доли.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBeGreaterThan(faded);
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    expect(drawnOpacity(ctx)).toBe(1);
    expect(subsystem.instanceFor(1)).not.toBeNull();
  });

  it('разрыв непрерывности (snapAll) убирает исчезнувших сразу — fade только на ходу мира', () => {
    const { subsystem, ctx } = makeRig(makeManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([], { snapAll: true }));
    expect(subsystem.instanceFor(1)).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });

  it('без опции fade поведение прежнее: исчезновение убирает инстанс сразу', () => {
    const { subsystem } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([]));
    expect(subsystem.instanceFor(1)).toBeNull();
  });
});

describe('FOW-8: кэш fade-копий материалов', () => {
  const FADE = 0.5;

  /** Материалы, которыми инстанс сущности нарисован СЕЙЧАС. */
  function drawnMaterials(ctx: RenderContext, entity: number): THREE.Material[] {
    const holder = ctx.scene.children.find((node) => node.name === `entity:${String(entity)}`);
    if (holder === undefined) throw new Error(`в сцене нет инстанса ${String(entity)}`);
    const materials: THREE.Material[] = [];
    holder.traverse((node) => {
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      if (mesh.isMesh !== true || mesh.material === undefined) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.push(material);
      }
    });
    if (materials.length === 0) throw new Error('у инстанса нет меша');
    return materials;
  }

  it('копия материала переиспользуется следующим эпизодом, а не собирается заново', () => {
    const { subsystem, ctx, assets } = makeRig(plainManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    // Первый эпизод — fade-in появления: меши идут на своих прозрачных копиях.
    subsystem.updateFrame(1 / 60, 1);
    const episode = drawnMaterials(ctx, 1);
    expect(episode[0]!.transparent).toBe(true);

    // Проявление доиграло — разделяемые материалы вернулись мешам (REND-3),
    // а копия отложена в пул, а не освобождена.
    const disposed = vi.spyOn(episode[0]!, 'dispose');
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    expect(drawnMaterials(ctx, 1)[0]).not.toBe(episode[0]);
    expect(disposed).not.toHaveBeenCalled();

    // Второй эпизод — уход в туман. Копия ТА ЖЕ: у прозрачной копии своя
    // программа шейдера, и собирать её заново на каждое открытие обзора
    // значило бы платить компиляцией в кадре.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1 / 60, 1);
    const reused = drawnMaterials(ctx, 1);
    expect(reused[0]).toBe(episode[0]);
    // База непрозрачности берётся у оригинала на каждой выдаче: доля второго
    // эпизода считается от единицы, а не от того, чем эпизод кончился.
    expect(reused[0]!.opacity).toBeGreaterThan(0.9);
  });

  it('копия из пула пересобирается по оригиналу: доехавшая текстура доезжает и до неё', () => {
    const { subsystem, ctx, assets } = makeRig(plainManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    // Эпизод начался В ОКНЕ ЗАГРУЗКИ: текстуры слота ещё нет (ASSET-4), и копия
    // снята с материала без карты.
    subsystem.updateFrame(1 / 60, 1);
    const episode = drawnMaterials(ctx, 1)[0]! as THREE.MeshStandardMaterial;
    expect(episode.map).toBeNull();

    // Текстура доехала — `ensureBaseSkin` пишет её в ОРИГИНАЛ задним числом.
    assets.resolve('texture', 'tex/base.png', {
      width: 1,
      height: 1,
      format: 'rgba8',
      pixels: Uint8Array.from([1, 2, 3, 255]),
    });
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    const original = drawnMaterials(ctx, 1)[0]! as THREE.MeshStandardMaterial;
    expect(original.map).not.toBeNull();

    // Второй эпизод берёт ту же копию из пула — и она обязана рисовать текстуру
    // оригинала. Иначе модель угасала бы нетекстурированной весь остаток
    // сессии, да ещё и своей программой: занятость слота карты входит в её ключ.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1 / 60, 1);
    const reused = drawnMaterials(ctx, 1)[0]! as THREE.MeshStandardMaterial;
    expect(reused).toBe(episode);
    expect(reused.map).toBe(original.map);
    expect(reused.transparent).toBe(true);
  });

  it('одновременное угасание инстансов одного материала: копии свои, доли не спорят', () => {
    const { subsystem, ctx, assets } = makeRig(plainManifest(), { fadeSeconds: FADE });
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);
    // Скин ничего не подменяет — материал у обоих ОДИН, разделяемый с ассетом.
    expect(drawnMaterials(ctx, 1)[0]).toBe(drawnMaterials(ctx, 2)[0]);

    // Первый ушёл в туман, шестью кадрами позже — второй: угасают оба, но
    // доли у них заведомо разные.
    subsystem.syncTick(makeTickView([makeEntityView(2)]));
    for (let i = 0; i < 6; i++) subsystem.updateFrame(1 / 60, 1);
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1 / 60, 1);

    const first = drawnMaterials(ctx, 1)[0]!;
    const second = drawnMaterials(ctx, 2)[0]!;
    // `opacity` — свойство МАТЕРИАЛА: одна копия на двоих показывала бы долю
    // одного на другом, поэтому копия выдаётся на меш каждого.
    expect(first).not.toBe(second);
    expect(first.opacity).toBeLessThan(second.opacity);
  });
});

/**
 * Фиксация клипа смерти следует ДОСТАВЛЕННОМУ состоянию (REND-4, FOW-8).
 * Событие живёт один тик, инстанс — сколько угодно: труп, ушедший в туман и
 * вернувшийся, создаётся заново и о `EntityDied` узнать не может (OBS-5), а
 * сцена с двумя видами возрождения не описывается одним именем события.
 */
describe('состояние смерти из доставки (REND-4, FOW-8)', () => {
  /** Сборка, назвавшая состояние смерти: бит 0 словаря — `Dead`. */
  const DEAD_BIT = 1;
  function deadRig(): ReturnType<typeof makeRig> {
    return makeRig(makeManifest(), { stateComponents: ['Dead'], deadState: 'Dead' });
  }

  it('появившийся мёртвым встаёт трупом, не разыгрывая гибель заново', () => {
    const { subsystem, assets } = deadRig();
    // Первая доставка, в которой сущность видна, уже называет её мёртвой:
    // умерла она в тумане, и события её гибели этот клиент не получал.
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));
    assets.resolve('model', MODEL_ID, makeModel());

    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });

  it('гибель НА ГЛАЗАХ по-прежнему играет клип событием, а не состоянием', () => {
    const { subsystem, assets } = deadRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;
    controller.setState('move');

    // На тике гибели маркер в мире уже стоит, и состояние приезжает вместе с
    // событием. Фиксируй подсистема по состоянию всякий инстанс — событие
    // застало бы контроллер уже мёртвым, и клип смерти не сыграл бы вовсе.
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { states: DEAD_BIT })], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );

    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
    // Клип именно ИГРАЕТ, а не стоит на конце: фаза ещё не дошла до края.
    subsystem.updateFrame(0.1, 1);
    expect(controller.currentClipName).toBe('Death');
  });

  it('снятый маркер поднимает модель, каким бы событием сцена ни возрождала', () => {
    // Сборка НЕ называет события возрождения вовсе — так и живёт сцена, у
    // которой возрождений несколько, а имя в опции одно.
    const { subsystem, assets } = deadRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const controller = subsystem.instanceFor(1)!.controller!;
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { states: DEAD_BIT })], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    expect(controller.isDead).toBe(true);

    // Возрождение сцены: тот же идентификатор теряет маркер, мир непрерывен.
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));

    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('вернувшийся из тумана труп — труп: инстанс новый, события не было', () => {
    const { subsystem, assets } = makeRig(makeManifest(), {
      fadeSeconds: 0.2,
      stateComponents: ['Dead'],
      deadState: 'Dead',
    });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { states: DEAD_BIT })], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    const first = subsystem.instanceFor(1)!;
    expect(first.controller!.isDead).toBe(true);

    // Труп ушёл в туман: без события смерти на ЭТОМ тике инстанс доживает
    // fade-out (FOW-8) и снимается по его концу.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1, 1);
    expect(subsystem.instanceFor(1)).toBeNull();

    // И вернулся — всё ещё мёртвым. Инстанс новый, `EntityDied` в прошлом не
    // переигрывается: единственный источник правды — доставленное состояние.
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));
    const second = subsystem.instanceFor(1)!;
    expect(second).not.toBe(first);
    expect(second.controller!.isDead).toBe(true);
    expect(second.controller!.currentClipName).toBe('Death');
  });

  it('без названного состояния поведение прежнее: только событие и возрождение', () => {
    const { subsystem, assets } = makeRig(makeManifest(), { fadeSeconds: 0.2 });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { states: DEAD_BIT })], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1, 1);

    // Тот же бит состояния, но сборка его не назвала — подсистема о нём не
    // знает, и вернувшийся инстанс встаёт живым, как и до этой правки.
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));
    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(false);
  });

  it('имя состояния вне словаря сборки — предупреждение один раз, путь прежний', () => {
    const { subsystem, assets, warnings } = makeRig(makeManifest(), {
      stateComponents: ['Shielded'],
      deadState: 'Dead',
    });
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));

    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(false);
    expect(warnings.filter((message) => message.includes('состояние смерти'))).toHaveLength(1);
  });
});

/**
 * Персональная шкала времени сущности (REND-38): подсистема отдаёт её
 * контроллеру вторым аргументом кадра, и замедленная симуляцией сущность
 * перебирает анимацией во столько же раз медленнее. Что делает со шкалой сам
 * носитель воспроизведения, проверяет `animation.test.ts`; здесь — что кадр
 * подсистемы её ДОНОСИТ, а сглаживания картинки ею не трогает.
 */
describe('персональная шкала времени сущности (REND-38)', () => {
  /** Событие каста обеим сущностям сразу — one-shot 'Attack - 1' на 0.5 с. */
  function castOn(
    subsystem: ModelsSubsystem,
    views: readonly ReturnType<typeof makeEntityView>[],
    entity: number,
  ): void {
    subsystem.syncTick(
      makeTickView([...views], { freshEvents: true, events: [{ type: 'CastFireball', data: { entity } }] }),
    );
  }

  it('замедленная сущность доигрывает one-shot во столько же раз позже', () => {
    const { subsystem, assets } = makeRig();
    const full = makeEntityView(1, { moving: true });
    const slow = makeEntityView(2, { moving: true, timeScale: 0.2 });
    subsystem.syncTick(makeTickView([full, slow]));
    assets.resolve('model', MODEL_ID, makeModel());
    castOn(subsystem, [full, slow], 1);
    castOn(subsystem, [full, slow], 2);
    const fullClip = (): string | null => subsystem.instanceFor(1)!.controller!.currentClipName;
    const slowClip = (): string | null => subsystem.instanceFor(2)!.controller!.currentClipName;
    expect(fullClip()).toBe('Attack - 1');
    expect(slowClip()).toBe('Attack - 1');

    // 0.6 с кадрового времени: обычной сущности хватило на весь клип (0.5 с),
    // замедленной — только на 0.12 с его фазы.
    for (let i = 0; i < 36; i++) subsystem.updateFrame(1 / 60, 1);
    expect(fullClip()).toBe('Walk Fast');
    expect(slowClip()).toBe('Attack - 1');

    // Свои 2.5 с кадрового времени она отыгрывает — и возвращается тем же путём.
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    expect(slowClip()).toBe('Walk Fast');
  });

  it('обратный ход масштабируется вместе с прямым (REND-25 + REND-38)', () => {
    const { subsystem, assets } = makeRig();
    const slow = makeEntityView(1, { moving: true, timeScale: 0.2 });
    subsystem.syncTick(makeTickView([slow]));
    assets.resolve('model', MODEL_ID, makeModel());
    castOn(subsystem, [slow], 1);
    const clip = (): string | null => subsystem.instanceFor(1)!.controller!.currentClipName;

    // Полсекунды вперёд — это 0.1 с фазы замедленного клипа.
    for (let i = 0; i < 30; i++) subsystem.updateFrame(1 / 60, 1);
    expect(clip()).toBe('Attack - 1');

    // Полсекунды назад: фаза отматывается тем же персональным темпом и
    // возвращается ровно к началу клипа — one-shot уступает клипу состояния.
    for (let i = 0; i < 30; i++) subsystem.updateFrame(-1 / 60, 1);
    expect(clip()).toBe('Walk Fast');
  });

  it('доворот шкале не подчиняется: сглаживание картинки идёт своим темпом', () => {
    const { subsystem, assets } = makeRig();
    const full = makeEntityView(1, { moving: true });
    const slow = makeEntityView(2, { moving: true, timeScale: 0.2 });
    subsystem.syncTick(makeTickView([full, slow]));
    assets.resolve('model', MODEL_ID, makeModel());
    // Первый кадр ставит курс мгновенно (snapPending): доворот меряется со
    // второй доставки, когда цель уже сменилась.
    subsystem.updateFrame(1 / 60, 1);
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { moving: true, facingYaw: Math.PI / 2 }),
        makeEntityView(2, { moving: true, facingYaw: Math.PI / 2, timeScale: 0.2 }),
      ]),
    );

    for (let i = 0; i < 10; i++) subsystem.updateFrame(1 / 60, 1);
    const fullYaw = subsystem.instanceFor(1)!.pose.yaw;
    const slowYaw = subsystem.instanceFor(2)!.pose.yaw;
    // Курс — не часы мира, а сходящаяся к цели величина кадра: у замедленной
    // сущности он идёт ровно тем же темпом, что у обычной, и цели ещё не достиг
    // (иначе сравнивались бы две единицы).
    expect(slowYaw).toBeCloseTo(fullYaw, 10);
    expect(fullYaw).toBeGreaterThan(0);
    expect(fullYaw).toBeLessThan(Math.PI / 2);
  });
});


/**
 * Авторитет смерти — на ЗАПИСИ инстанса (REND-4), а не в её сегодняшнем
 * контроллере. Контроллер — носитель воспроизведения: он вправе появиться позже
 * модели (`assets` ASSET-4), смениться вместе с ярусом (REND-20, QUAL-1) и
 * пересобраться переподачей манифеста (REND-17), — а сущность всё это время
 * мертва, и каждый следующий контроллер обязан встать трупом так же, как встал
 * бы первый.
 */
describe('фиксация смерти переживает смену контроллера (REND-4)', () => {
  /** Сборка, назвавшая состояние смерти: бит 0 словаря — `Dead`. */
  const DEAD_BIT = 1;

  /** Запись без контроля костей: ярус ей выбирает пресет (QUAL-1, REND-20). */
  function tierlessManifest(): VisualManifest {
    const manifest = makeManifest();
    delete manifest.entities.Runner!.boneControls;
    return manifest;
  }

  function died(entity: number): Parameters<typeof makeTickView>[1] {
    return { freshEvents: true, events: [{ type: 'EntityDied', data: { entity } }] };
  }

  it('гибель ДО прихода модели: поздний контроллер встаёт трупом', () => {
    // Состояния смерти сборка не называет — путь событийный, как в сцене без
    // зеркалирования маркера.
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    // Контроллера ещё нет: модель — разделяемый ассет и вправе ехать сколько
    // угодно (ASSET-4), а гибель уже случилась, и терять её нельзя.
    expect(subsystem.instanceFor(1)!.controller).toBeNull();

    subsystem.syncTick(makeTickView([makeEntityView(1)], died(1)));
    assets.resolve('model', MODEL_ID, makeModel());

    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });

  it('то же с названным состоянием смерти: маркер доставки поднимает фиксацию', () => {
    const { subsystem, assets } = makeRig(makeManifest(), {
      stateComponents: ['Dead'],
      deadState: 'Dead',
    });
    // Инстанс появился ЖИВЫМ (маркера в этой доставке нет), поэтому «появился
    // уже мёртвым» тут ни при чём: смерть приходит событием при пустом
    // контроллере, а состояние лишь подтверждает её следующими доставками.
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })], died(1)));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1, { states: DEAD_BIT })]));

    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(true);
  });

  it('смена яруса по пресету не поднимает труп (QUAL-1 → REND-20)', () => {
    const { subsystem, assets } = makeRig(tierlessManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1)], died(1)));
    expect(subsystem.instanceFor(1)!.tier).toBe('batched');
    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(true);

    // Пресет переключил ярус записей, ярус не назвавших: инстанс пересобран, и
    // контроллер у него ДРУГОЙ — а сущность как была мертва, так и осталась.
    subsystem.applyQuality(new Map([['models.defaultTier', 'detailed']]));

    const controller = subsystem.instanceFor(1)!.controller!;
    expect(subsystem.instanceFor(1)!.tier).toBe('detailed');
    expect(controller.isDead).toBe(true);
    expect(controller.currentClipName).toBe('Death');
  });

  it('переподача манифеста со сменой модели не поднимает труп (REND-17)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1)], died(1)));

    const next = makeManifest();
    next.entities.Runner!.model = 'models/other.mdx';
    subsystem.applyManifest(next);
    assets.resolve('model', 'models/other.mdx', makeModel());

    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(true);
  });

  it('возрождение снимает фиксацию с записи, а не только с контроллера', () => {
    const { subsystem, assets } = makeRig(makeManifest(), { reviveEvent: 'HeroRespawned' });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([makeEntityView(1)], died(1)));
    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'HeroRespawned', data: { entity: 1 } }],
      }),
    );
    // Оба события пришлись на окно загрузки: и гибель, и возрождение записаны
    // на записи, и контроллер появляется живым.
    assets.resolve('model', MODEL_ID, makeModel());

    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(false);
  });

  it('разрыв непрерывности снимает фиксацию с записи (REND-2)', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.syncTick(makeTickView([makeEntityView(1)], died(1)));
    // Перемотка через момент смерти: мир авторитетно другой, и труп в нём жив.
    subsystem.syncTick(makeTickView([makeEntityView(1)], { snapAll: true }));
    assets.resolve('model', MODEL_ID, makeModel());

    expect(subsystem.instanceFor(1)!.controller!.isDead).toBe(false);
  });
});

/**
 * Провал наблюдаем ровно СНИЖЕНИЕМ (REND-4, REND-12): состояние `fall` —
 * представление опускающегося инстанса, а не отметка о полученном событии.
 */
describe('состояние fall выводится из снижения (REND-4, REND-12)', () => {
  type Offset = NonNullable<VisualManifest['entities'][string]['verticalOffset']>;

  /** Манифест с клипом состояния `fall`; параметры снижения — по требованию. */
  function fallManifest(offset?: Offset): VisualManifest {
    const manifest = makeManifest();
    const entry = manifest.entities.Runner!;
    entry.animations = {
      ...entry.animations,
      states: { ...entry.animations?.states, fall: 'Fall' },
    };
    if (offset !== undefined) entry.verticalOffset = offset;
    return manifest;
  }

  const fell = { freshEvents: true, events: [{ type: 'FellThroughFloor', data: { entity: 1 } }] };

  it('запись без параметров снижения в состояние fall не входит', () => {
    const { subsystem, assets } = makeRig(fallManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    subsystem.syncTick(makeTickView([makeEntityView(1)], fell));
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1);

    // Снижаться нечем — и клипа падения на стоящей сущности быть не должно:
    // иначе он держался бы до разрыва непрерывности, врал о происходящем и
    // перебивал бы состояния локомоции.
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Stand - 1');
    expect(subsystem.instanceFor(1)!.pose.z).toBe(0);
  });

  it('запись со снижением входит в него и опускается', () => {
    const { subsystem, assets } = makeRig(fallManifest({ fallSpeed: 6, fallDepth: 3 }));
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    subsystem.syncTick(makeTickView([makeEntityView(1)], fell));
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Fall');
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.pose.z).toBeLessThan(0);
  });

  it('снятые переподачей параметры снимают и состояние (REND-17)', () => {
    const { subsystem, assets } = makeRig(fallManifest({ fallSpeed: 6, fallDepth: 3 }));
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1)], fell));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.pose.z).toBeLessThan(0);

    // Автор убрал снижение из записи: инстанс возвращается на поверхность тем
    // же кадром, а состояние уходит вместе со снижением.
    subsystem.applyManifest(fallManifest());
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(1 / 60, 1);

    expect(subsystem.instanceFor(1)!.pose.z).toBe(0);
    expect(subsystem.instanceFor(1)!.controller!.currentClipName).toBe('Stand - 1');
  });
});

/**
 * Угасающий инстанс держит ПОСЛЕДНЕЕ доставленное состояние (FOW-8), и
 * интерполировать его заново нечем: альфа кадра принадлежит потоку доставок и
 * каждой следующей сбрасывается (REND-2).
 */
describe('поза записи в fade-out замирает (FOW-8 → REND-2)', () => {
  it('ушедший в туман юнит не отматывает свой последний шаг', () => {
    const { subsystem, assets } = makeRig(makeManifest(), { fadeSeconds: 0.5 });
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    for (let i = 0; i < 60; i++) subsystem.updateFrame(1 / 60, 1); // fade-in доигран

    // Последний доставленный шаг — из нуля в единицу по X.
    subsystem.syncTick(makeTickView([makeEntityView(1, { prevX: 0, currX: 1, moving: true })]));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1)!.pose.x).toBeCloseTo(1, 6);

    // Сущность ушла в туман: следующие кадры идут с альфой начала интервала —
    // так их и подаёт буфер доставки. Замри поза не здесь, юнит дрожал бы между
    // 0 и 1 весь fade.
    subsystem.syncTick(makeTickView([]));
    subsystem.updateFrame(1 / 60, 0);
    expect(subsystem.instanceFor(1)!.pose.x).toBeCloseTo(1, 6);
    subsystem.updateFrame(1 / 60, 0.5);
    expect(subsystem.instanceFor(1)!.pose.x).toBeCloseTo(1, 6);
    // Угасание при этом идёт: доля проявленности — не поза.
    expect(subsystem.instanceFor(1)).not.toBeNull();
  });
});

/**
 * Контактное пятно (REND-30) повторяет след НАРИСОВАННОГО инстанса, а не
 * консервативную границу отсечения по всем кадрам всех клипов (ASSET-12).
 */
describe('радиус контактного пятна — габарит bind-позы (REND-30)', () => {
  function blobRig(): { subsystem: ModelsSubsystem; assets: AssetsStub; casters: BlobCaster[] } {
    const casters: BlobCaster[] = [];
    const shadows: LightingSink = {
      setCaster: () => {},
      dropCaster: () => {},
      invalidateStatic: () => {},
      setBlobCaster: (caster) => { casters.push(caster); },
      dropBlobCaster: () => {},
    };
    const { subsystem, assets } = makeRig(makeManifest(), { shadows });
    return { subsystem, assets, casters };
  }

  it('пятно не раздувается границами отсечения', () => {
    const { subsystem, assets, casters } = blobRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    const model = makeModel();
    assets.resolve('model', MODEL_ID, model);

    const bounds = subsystem.instanceFor(1)!.bounds!;
    const expected = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
    expect(casters).toHaveLength(1);
    expect(casters[0]!.radius).toBeCloseTo(expected, 10);

    // Те же данные, что у отсечения (REND-21), дали бы пятно во много раз шире:
    // запечённые границы — объединение всех кадров всех клипов, то есть выпад
    // атаки и распластанная смерть разом, и след юнита ими раздут всю его жизнь.
    const baked = modelDerivatives(model);
    if (!baked.ok) throw new Error('фикстура обязана давать запечённые производные');
    const normalized = 1 / model.height; // масштаб записи 1, высота модели → 1
    const cullWidth = Math.max(
      baked.derivatives.bounds.max[0] - baked.derivatives.bounds.min[0],
      baked.derivatives.bounds.max[1] - baked.derivatives.bounds.min[1],
    ) * normalized;
    expect(casters[0]!.radius).toBeLessThan(cullWidth / 2);
  });
});

/**
 * Идентификатор сущности переиспользуется (NTR-16): после разветвления истории
 * освободившийся номер достаётся другому объекту, и его вид приезжает вместе с
 * ним. Правкой живой записи вид не применить — за ним и модель, и запись
 * манифеста, и ярус (REND-20).
 */
describe('смена вида под живым идентификатором пересоздаёт инстанс (NTR-16)', () => {
  it('запись того же номера с другим видом строится заново', () => {
    const manifest = makeManifest();
    manifest.entities.Keeper = { model: 'models/keeper.mdx', scale: 1 };
    const { subsystem, assets } = makeRig(manifest);

    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const before = subsystem.instanceFor(1)!;
    expect(before.model).not.toBeNull();

    // Тот же номер — другой вид. Наследовать чужую модель он не вправе.
    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: 'Keeper' })]));
    const after = subsystem.instanceFor(1)!;
    expect(after).not.toBe(before);
    // Модель нового вида ещё не доехала — значит и рисуется заглушка (ASSET-4),
    // а не поддерево прежнего вида.
    expect(after.placeholder).toBe(true);
    expect(after.model).toBeNull();
    expect(assets.requests).toContainEqual({ kind: 'model', id: 'models/keeper.mdx' });

    // Дорога, которой этот случай приходит на самом деле: ветвление истории
    // (NTR-16) поднимает `snapAll`, и освободившийся номер приезжает уже с
    // чужим видом. Правило то же — запись пересоздаётся.
    assets.resolve('model', 'models/keeper.mdx', makeModel());
    subsystem.syncTick(makeTickView([makeEntityView(1)], { snapAll: true }));
    const branched = subsystem.instanceFor(1)!;
    expect(branched).not.toBe(after);
    expect(branched.model).not.toBeNull();
  });

  it('вид, ставший невизуальным, убирает нарисованное', () => {
    const { subsystem, ctx, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(ctx.scene.children.length).toBe(1);

    subsystem.syncTick(makeTickView([makeEntityView(1, { kind: null })]));
    expect(subsystem.instanceFor(1)!.model).toBeNull();
    expect(ctx.scene.children.length).toBe(0);
  });
});

/**
 * Пиксели скина разделяются модулем ассетов (ASSET-2), и GPU-текстура за ними
 * — тоже (REND-3, REND-6): десять инстансов одного скина заливают одну картинку
 * в видеопамять ОДИН раз.
 */
describe('текстуры скина разделяются инстансами (REND-6 → REND-31)', () => {
  /** Карта базового цвета первого материала инстанса. */
  function baseMap(subsystem: ModelsSubsystem, entity: number): THREE.Texture | null {
    return subsystem.instanceFor(entity)!.model!.materials[0]!.map;
  }

  it('N инстансов одного скина держат одну текстуру', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2), makeEntityView(3)]));
    assets.resolve('model', MODEL_ID, makeModel());
    assets.resolve('texture', 'tex/red.png', {
      width: 1,
      height: 1,
      format: 'rgba8',
      pixels: Uint8Array.from([9, 9, 9, 255]),
    });

    const first = baseMap(subsystem, 1);
    expect(first).not.toBeNull();
    expect(baseMap(subsystem, 2)).toBe(first);
    expect(baseMap(subsystem, 3)).toBe(first);

    // Смена скина одного инстанса заводит текстуру ДРУГИХ пикселей — и соседей
    // не трогает (REND-6).
    assets.resolve('texture', 'tex/blue.png', {
      width: 1,
      height: 1,
      format: 'rgba8',
      pixels: Uint8Array.from([1, 2, 3, 255]),
    });
    subsystem.setSkin(1, 'blue');
    expect(baseMap(subsystem, 1)).not.toBe(first);
    expect(baseMap(subsystem, 2)).toBe(first);
  });

  it('текстура уходит с последней ссылкой, а не с первой', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    assets.resolve('texture', 'tex/red.png', {
      width: 1,
      height: 1,
      format: 'rgba8',
      pixels: Uint8Array.from([9, 9, 9, 255]),
    });
    const shared = baseMap(subsystem, 1)!;
    const disposed = vi.spyOn(shared, 'dispose');

    // Первый инстанс снят — текстуру держит второй.
    subsystem.syncTick(makeTickView([makeEntityView(2)]));
    expect(disposed).not.toHaveBeenCalled();
    expect(baseMap(subsystem, 2)).toBe(shared);

    // Ушёл и он: держать пиксели в видеопамяти больше некому (REND-31).
    subsystem.syncTick(makeTickView([]));
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ожидание готовности модели живёт ССЫЛКОЙ на записи (`waitingOn`): снятый
 * инстанс обязан уйти из ожиданий своего — и только своего — ассета.
 */
describe('ожидание ассета снимается вместе с инстансом (ASSET-4)', () => {
  it('доехавшая модель не достаётся снятому инстансу', () => {
    const { subsystem, ctx, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    const waiting = subsystem.instanceFor(1)!;

    // Первый ушёл, пока модель ещё ехала.
    subsystem.syncTick(makeTickView([makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());

    expect(waiting.model).toBeNull();
    expect(subsystem.instanceFor(2)!.model).not.toBeNull();
    // В сцене остался ровно один держатель — снятый ничего в неё не вернул.
    expect(ctx.scene.children.length).toBe(1);
  });
});
