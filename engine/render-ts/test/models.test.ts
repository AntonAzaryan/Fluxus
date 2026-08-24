/**
 * Подсистема моделей: пул инстансов по снапшоту (REND-3), заглушки на время
 * загрузки и при отсутствии записи в манифесте (ASSET-4, ASSET-6), скины
 * пер-инстанс (REND-6), смерть по событию (REND-4), интерполяция позиции.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ModelsSubsystem, type RenderContext } from '../src/index.js';
import type { VisualManifest } from '@fluxus/assets';
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
  options: { readonly reviveEvent?: string; readonly fadeSeconds?: number } = {},
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
