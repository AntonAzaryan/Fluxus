/**
 * Батчевый ярус (REND-20): жизненный цикл записи в батче, отсечение и
 * компактация (REND-21), скин индексом варианта (REND-6), one-shot по событию
 * тика (REND-4), деградация модели без запечённых производных, picking по
 * батчевой записи (REND-15), декорации тем же путём (REND-18) и переподача
 * манифеста (REND-17).
 *
 * Всё headless: `InstancedMesh`, атрибуты и `DataTexture` — данные, а не
 * GPU-объекты, пока их некому нарисовать. Проверяется путь ДАННЫХ; сам GLSL
 * VAT-материала компилируется только рендерером, и его в прогоне нет — это
 * известное ограничение (`model/vatMaterial.ts`).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { NormalizedModel, VisualManifest } from '@game-mvp/assets';
import { ModelsSubsystem, createPickProxy, type RenderContext } from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView, type AssetsStub } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

/** Запись без контроля костей — батчевый ярус по умолчанию (ASSET-13). */
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
      },
    },
  };
}

interface Rig {
  readonly subsystem: ModelsSubsystem;
  readonly ctx: RenderContext;
  readonly assets: AssetsStub;
  readonly warnings: string[];
}

function makeRig(
  manifest: VisualManifest = makeManifest(),
  camera?: THREE.Camera,
): Rig {
  const assets = makeAssets();
  const warnings: string[] = [];
  const ctx: RenderContext = {
    scene: new THREE.Scene(),
    assets: assets.service,
    config: { heightStep: 0.5 },
  };
  const subsystem = new ModelsSubsystem(manifest, {
    warn: (message) => warnings.push(message),
    ...(camera === undefined ? {} : { camera }),
  });
  subsystem.init(ctx);
  return { subsystem, ctx, assets, warnings };
}

/** Инстанс-атрибут позы первого меша батча: строка A, строка B, вес, слой скина. */
function poseAttribute(subsystem: ModelsSubsystem): Float32Array {
  const mesh = subsystem.batchMeshes()[0]!;
  return mesh.geometry.getAttribute('instancePose').array as Float32Array;
}

// ------------------------------------------------------- жизненный цикл

describe('жизненный цикл записи батча (REND-3, REND-20)', () => {
  it('запись без контроля костей рисуется батчевым ярусом и не заводит поддерева', () => {
    const { subsystem, ctx, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());

    const instance = subsystem.instanceFor(1)!;
    expect(instance.tier).toBe('batched');
    // Скелета, микшера и материалов на инстанс у батчевой записи нет: наружу
    // она видна преобразованием и границами (REND-3).
    expect(instance.model).toBeNull();
    expect(instance.placeholder).toBe(false);
    expect(instance.bounds).not.toBeNull();
    // В сцене один узел — сам батч, а не узел на инстанс.
    expect(ctx.scene.children.length).toBe(1);
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });
  });

  it('исчезновение убирает запись; батч остаётся в кэше и из кадра уходит пустым', () => {
    const { subsystem, ctx, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(subsystem.batchStats().records).toBe(2);

    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    expect(subsystem.batchStats().records).toBe(1);

    subsystem.syncTick(makeTickView([]));
    expect(subsystem.instanceFor(1)).toBeNull();
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 0 });
    // Пустой набор не оставляет в кадре ничего (REND-11): узел батча снят.
    expect(ctx.scene.children.length).toBe(0);

    // Ассет и батч в кэше: повторный спавн заново ничего не запрашивает (REND-3).
    const before = assets.requests.filter((request) => request.kind === 'model').length;
    subsystem.syncTick(makeTickView([makeEntityView(3)]));
    expect(assets.requests.filter((request) => request.kind === 'model').length).toBe(before);
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });
  });

  it('ёмкость растёт без пересоздания живых записей', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const first = subsystem.instanceFor(1)!;

    // Начальная ёмкость батча — 32; сотня записей её удваивает трижды.
    const many = Array.from({ length: 100 }, (_, i) => makeEntityView(i + 1));
    subsystem.syncTick(makeTickView(many));
    subsystem.updateFrame(1 / 60, 1);

    // Вид инстанса стабилен на всё время жизни записи — им и наблюдается
    // «запись та же», хотя буферы под ней переехали (REND-17).
    expect(subsystem.instanceFor(1)).toBe(first);
    expect(subsystem.batchStats().records).toBe(100);
    expect(subsystem.batchMeshes()[0]!.count).toBe(100);
  });
});

// -------------------------------------------------------------- стоимость

describe('число draw calls не растёт с числом инстансов (REND-20)', () => {
  it('двести инстансов одной модели рисуются тем же числом мешей, что один', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
    const alone = subsystem.batchStats().drawnMeshes;

    subsystem.syncTick(
      makeTickView(Array.from({ length: 200 }, (_, i) => makeEntityView(i + 1))),
    );
    subsystem.updateFrame(1 / 60, 1);
    const army = subsystem.batchStats();

    // Меш на часть модели — и всё: замер `renderer.info` в headless-прогоне
    // невозможен, но растёт или нет число мешей, видно и без рендерера.
    expect(army.drawnMeshes).toBe(alone);
    expect(army.batches).toBe(1);
    expect(army.records).toBe(200);
    expect(subsystem.batchMeshes()[0]!.count).toBe(200);
  });
});

// -------------------------------------------------------------- отсечение

describe('отсечение и компактация батчевых записей (REND-21)', () => {
  /** Камера смотрит вдоль +X: всё, что позади неё, заведомо вне пирамиды. */
  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.up.set(0, 0, 1);
    camera.position.set(0, 0, 1);
    camera.lookAt(10, 0, 1);
    camera.updateMatrixWorld(true);
    return camera;
  }

  it('армия за краем экрана не попадает в инстанс-буфер, но остаётся в наборе', () => {
    const { subsystem, assets } = makeRig(makeManifest(), makeCamera());
    const entities = [
      makeEntityView(1, { prevX: 10, currX: 10 }),
      ...Array.from({ length: 20 }, (_, i) =>
        makeEntityView(i + 2, { prevX: -10, currX: -10 }),
      ),
    ];
    subsystem.syncTick(makeTickView(entities));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);

    // Draw call'ы тратятся только на видимых: в буфере одна запись из 21.
    expect(subsystem.batchMeshes()[0]!.count).toBe(1);
    expect(subsystem.instanceFor(1)!.visible).toBe(true);
    expect(subsystem.instanceFor(2)!.visible).toBe(false);
    // Отсечение — стоимость кадра, а не состав набора: записи никуда не делись,
    // и прокси picking'а у них прежние (REND-15).
    expect(subsystem.batchStats().records).toBe(21);
    const seen: number[] = [];
    subsystem.eachProxy((proxy) => seen.push(proxy.entity));
    expect(seen.length).toBe(21);
  });

  it('границы отсечения — по клипам, а не по bind-позе (ASSET-12)', () => {
    // Запечённые границы модели шире её bind-позы: кость вращается, и сфера
    // влияния уходит за габариты покоя. Проверяется, что отсечение считает по
    // ним — иначе выпад у края экрана исчезал бы раньше юнита.
    const { subsystem, assets } = makeRig(makeManifest(), makeCamera());
    subsystem.syncTick(makeTickView([makeEntityView(1, { prevX: 10, currX: 10 })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
    const bounds = subsystem.instanceFor(1)!.bounds!;
    // Габариты инстанса остаются габаритами МОДЕЛИ (вход picking'а REND-15),
    // а консервативный объём живёт отдельно и в них не подмешан.
    expect(bounds.maxX - bounds.minX).toBeCloseTo(0.5, 6);
    expect(subsystem.instanceFor(1)!.visible).toBe(true);
  });

  it('сборка без камеры отсечения не делает: в буфере все записи', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { prevX: 10, currX: 10 }),
        makeEntityView(2, { prevX: -10, currX: -10 }),
      ]),
    );
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchMeshes()[0]!.count).toBe(2);
  });
});

// ------------------------------------------------------------------ скины

describe('скин батчевой записи — индекс варианта (REND-6)', () => {
  it('смена скина одной записи не трогает соседнюю и не пересоздаёт запись', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const before = subsystem.instanceFor(1)!;
    subsystem.updateFrame(1 / 60, 1);

    // Варианты записи в порядке индексов: базовый, затем скины по возрастанию —
    // `blue` (1), `red` (2).
    const initial = poseAttribute(subsystem);
    expect(initial[3]).toBe(2); // defaultSkin: red
    expect(initial[7]).toBe(2);

    subsystem.setSkin(1, 'blue');
    subsystem.updateFrame(1 / 60, 1);
    const after = poseAttribute(subsystem);
    expect(after[3]).toBe(1); // перекрашенная запись
    expect(after[7]).toBe(2); // сосед не тронут
    // Обе записи остались записями ОДНОГО батча (REND-6).
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 2 });
    expect(subsystem.instanceFor(1)).toBe(before);
  });

  it('текстуры вариантов запрашиваются один раз на батч, а не на инстанс', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(
      makeTickView([makeEntityView(1), makeEntityView(2), makeEntityView(3)]),
    );
    assets.resolve('model', MODEL_ID, makeModel());
    // Набор вариантов разделяемый: три инстанса не грузят красную текстуру
    // трижды, как это делает пер-инстансный скин детального яруса.
    expect(assets.requests.filter((request) => request.id === 'tex/red.png').length).toBe(1);
    expect(assets.requests.filter((request) => request.id === 'tex/blue.png').length).toBe(1);
  });
});

// ------------------------------------------------------------- анимация

describe('анимация батчевой записи (REND-4, REND-20)', () => {
  it('состояния и one-shot по событию тика — как у детального яруса', () => {
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

    // One-shot доигрывается и возвращает локомоцию — поведение неотличимо от
    // детального яруса (REND-20).
    for (let i = 0; i < 40; i++) subsystem.updateFrame(1 / 60, 1);
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('смерть фиксирует последний кадр клипа навсегда', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1)], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    const controller = subsystem.instanceFor(1)!.controller!;
    expect(controller.isDead).toBe(true);
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    expect(controller.currentClipName).toBe('Death');
  });

  it('фаза клипа уходит в строки VAT: пара соседних кадров и вес между ними', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    // Кроссфейд отыгран — дальше пара держит соседние кадры одного клипа.
    for (let i = 0; i < 20; i++) subsystem.updateFrame(1 / 60, 1);
    const pose = poseAttribute(subsystem);
    expect(pose[1]! - pose[0]!).toBe(1);
    expect(pose[2]!).toBeGreaterThanOrEqual(0);
    expect(pose[2]!).toBeLessThan(1);
  });
});

// -------------------------------------------------------------- деградация

describe('модель без запечённых производных (REND-20)', () => {
  /** Модель без костей: матрицы скининга брать неоткуда — запекать нечего. */
  function bonelessModel(): NormalizedModel {
    return { ...makeModel(), bones: [], sequences: [] };
  }

  it('рисуется детальным ярусом с предупреждением один раз на модель', () => {
    const { subsystem, assets, warnings } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, bonelessModel());

    expect(subsystem.instanceFor(1)!.tier).toBe('detailed');
    expect(subsystem.instanceFor(1)!.model).not.toBeNull();
    expect(subsystem.instanceFor(2)!.tier).toBe('detailed');
    expect(subsystem.batchStats().batches).toBe(0);
    // Предупреждение одно на МОДЕЛЬ, а не на инстанс.
    const complaints = warnings.filter((message) => message.includes('производных'));
    expect(complaints.length).toBe(1);
    expect(complaints[0]).toContain(MODEL_ID);
  });
});

// ----------------------------------------------------------------- picking

describe('picking по батчевой записи (REND-15)', () => {
  it('прокси несёт то же преобразование и те же границы, что нарисованное', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(
      makeTickView([
        makeEntityView(1, { prevX: 3, currX: 3, prevY: 4, currY: 4, scale: 2 }),
      ]),
    );
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);

    const proxy = createPickProxy();
    expect(subsystem.proxyOf(1, proxy)).toBe(true);
    expect(proxy.posX).toBeCloseTo(3, 6);
    expect(proxy.posY).toBeCloseTo(4, 6);
    expect(proxy.scaleX).toBeCloseTo(2, 6);
    const bounds = subsystem.instanceFor(1)!.bounds!;
    expect(proxy.maxZ).toBeCloseTo(bounds.maxZ, 6);
  });
});

// ------------------------------------------------------- переподача записи

describe('переподача манифеста для батчевого яруса (REND-17)', () => {
  it('смена яруса записи пересобирает запись, прочее применяется на месте', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    const view = subsystem.instanceFor(1)!;
    expect(view.tier).toBe('batched');

    // Масштаб — не то, что строится из разделяемых данных: запись остаётся в
    // своём батче, меняется только нормализующий множитель.
    const scaled = makeManifest();
    scaled.entities.Runner!.scale = 3;
    subsystem.applyManifest(scaled);
    subsystem.updateFrame(1 / 60, 1);
    expect(view.tier).toBe('batched');
    // Габариты пересчитаны тем же множителем нормализации: масштаб записи 3
    // при высоте модели 2 даёт 1.5 от канонического максимума по X.
    expect(view.bounds!.maxX).toBeCloseTo(1.5, 6);
    expect(subsystem.batchStats().batches).toBe(1);

    // Явный детальный ярус — другое представление: запись пересобрана.
    const detailed = makeManifest();
    detailed.entities.Runner!.tier = 'detailed';
    subsystem.applyManifest(detailed);
    expect(subsystem.instanceFor(1)).toBe(view); // сам инстанс тот же (REND-11)
    expect(view.tier).toBe('detailed');
    expect(view.model).not.toBeNull();
    expect(subsystem.batchStats().records).toBe(0);
  });

  it('смена hiddenParts переводит запись в другой батч', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 1 });

    const next = makeManifest();
    next.entities.Runner!.hiddenParts = [0];
    subsystem.applyManifest(next);
    // Другой набор рисуемых частей — другой батч; прежний остался в кэше пустым.
    expect(subsystem.batchStats()).toMatchObject({ batches: 2, records: 1 });
  });
});

// -------------------------------------------------------------- декорации

describe('декорации идут в батчевый ярус тем же сведением (REND-18)', () => {
  it('набор decoration даёт записи батча, а не поддеревья, и живёт своим пулом', () => {
    const { subsystem, assets } = makeRig();
    const set = new Map([
      [1, makeEntityView(1, { prevX: 1, currX: 1 })],
      [2, makeEntityView(2, { prevX: 2, currX: 2 })],
    ]);
    subsystem.syncDecorations(set);
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.updateFrame(1 / 60, 1);

    expect(subsystem.decorationCount).toBe(2);
    expect(subsystem.instanceFor(1, true)!.tier).toBe('batched');
    // Записи decoration и записи presentation-состояния делят ОДИН батч: путь
    // отрисовки у них один, разные у них только пулы (REND-18).
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 3 });
    expect(subsystem.batchMeshes()[0]!.count).toBe(3);

    // Клип покоя записи: событий у декорации нет, состояние произвести не из чего.
    expect(subsystem.instanceFor(1, true)!.controller!.currentClipName).toBe('Stand - 1');

    // Правка набора не мигает объектом: инстанс тот же, батч тот же.
    const before = subsystem.instanceFor(1, true)!;
    set.get(1)!.currX = 7;
    subsystem.syncDecorations(set);
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.instanceFor(1, true)).toBe(before);
    expect(before.pose.x).toBeCloseTo(7, 6);
  });
});

// ---------------------------------------------------- видимость частей

describe('видимость частей батчевой записи (ASSET-12)', () => {
  /** Модель, у которой трек гасит часть 1 на всём клипе покоя. */
  function twoPartModel(): NormalizedModel {
    const base = makeModel();
    const mesh = base.meshes[0]!;
    return {
      ...base,
      meshes: [mesh, { ...mesh, partId: 1 }],
      sequences: [
        {
          ...base.sequences[0]!,
          partVisibility: [
            { partId: 1, times: new Float32Array([0]), visible: new Uint8Array([0]) },
          ],
        },
      ],
    };
  }

  it('погашенная кадром часть не попадает в свой инстанс-буфер', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, twoPartModel());
    subsystem.updateFrame(1 / 60, 1);

    const meshes = subsystem.batchMeshes();
    expect(meshes.length).toBe(2);
    const byName = new Map(meshes.map((mesh) => [mesh.name, mesh.count]));
    expect(byName.get('batch:part0')).toBe(1);
    // Трек гасит часть 1 — её меш в этом кадре не рисует ничего (REND-4).
    expect(byName.get('batch:part1')).toBe(0);
  });
});
