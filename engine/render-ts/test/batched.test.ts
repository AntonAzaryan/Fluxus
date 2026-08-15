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

/**
 * Манифест с СОСЕДНЕЙ записью на той же модели: у неё свой батч (ключ включает
 * запись, REND-20) и своя таблица скинов — по ней и видно, что правка чужих
 * вариантов её набора не пересобирает.
 */
function withNeighbour(): VisualManifest {
  const manifest = makeManifest();
  manifest.entities.Keeper = {
    model: MODEL_ID,
    scale: 1,
    defaultSkin: 'gold',
    skins: { gold: { '0': 'tex/gold.png' } },
  };
  return manifest;
}

/** Батчи в порядке заведения: сперва `Runner`, затем сосед `Keeper`. */
const RUNNER_BATCH = 0;
const KEEPER_BATCH = 1;

/** Слой скина записи батча — четвёртое число её инстанс-позы (REND-6). */
function layerOf(subsystem: ModelsSubsystem, batch: number, record: number): number {
  const mesh = subsystem.batchMeshes()[batch]!;
  const pose = mesh.geometry.getAttribute('instancePose').array as Float32Array;
  return pose[record * 4 + 3]!;
}

function requestCount(assets: AssetsStub, id: string): number {
  return assets.requests.filter((request) => request.id === id).length;
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

  it('доставка снапом снимает смерть: перемотка через неё не оставляет труп навсегда', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], {
        freshEvents: true,
        events: [{ type: 'EntityDied', data: { entity: 1 } }],
      }),
    );
    const controller = subsystem.instanceFor(1)!.controller!;
    for (let i = 0; i < 120; i++) subsystem.updateFrame(1 / 60, 1);
    expect(controller.isDead).toBe(true);

    // Перемотка вернула мир к моменту до смерти: состояние другое, а
    // непрерывности с прежним нет (REND-2). `EntityDied` в прошлом не
    // разэмитится — без этого сброса живой персонаж лежал бы вечно.
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], { snapAll: true, mode: 'Rewinding' }),
    );

    expect(controller.isDead).toBe(false);
    expect(controller.currentClipName).toBe('Walk Fast');
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

// ------------------------------------------------- обратный ход презентации

/**
 * Батчевый ярус при не-`Running` мире (REND-25). Наблюдаемое — те же строки
 * VAT, что и в кадре: своей «фазы» наружу запись не отдаёт, а строка и есть
 * кадр клипа, которым инстанс нарисован.
 */
describe('обратный ход клипа в батчевом ярусе (REND-25, REND-20)', () => {
  function running(): Rig {
    const rig = makeRig();
    rig.subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    rig.assets.resolve('model', MODEL_ID, makeModel());
    // Кроссфейд входа отыгран, фаза ушла вглубь клипа.
    for (let i = 0; i < 20; i++) rig.subsystem.updateFrame(1 / 60, 1);
    return rig;
  }

  it('мир замер — клипы замерли: кадры идут, строки VAT стоят', () => {
    const { subsystem } = running();
    const frozen = Array.from(poseAttribute(subsystem).slice(0, 3));
    for (let i = 0; i < 30; i++) subsystem.updateFrame(0, 1);
    expect(Array.from(poseAttribute(subsystem).slice(0, 3))).toEqual(frozen);
  });

  it('отрицательные часы отматывают клип и заворачивают фазу через его начало', () => {
    const { subsystem } = running();
    const forward = poseAttribute(subsystem)[0]!;

    for (let i = 0; i < 10; i++) subsystem.updateFrame(-1 / 60, 1);
    const back = poseAttribute(subsystem)[0]!;
    expect(back).toBeLessThan(forward);

    // Ещё назад, за начало клипа: зацикленный клип уходит на свой хвост, а не
    // стопорится на нулевом кадре.
    for (let i = 0; i < 20; i++) subsystem.updateFrame(-1 / 60, 1);
    const wrapped = poseAttribute(subsystem)[0]!;
    expect(wrapped).toBeGreaterThan(forward);

    // Возобновление: вперёд с текущей строки, а не с начала клипа. Счёт
    // ТОЧНЫЙ, а не «не больше трёх»: пять кадров по 1/60 с — это 1/12 секунды,
    // при 30 запечённых кадрах в секунду ровно две с половиной строки, и с
    // фазы 5/6 они дают три пройденные строки. Верхняя граница пропустила бы и
    // «строка не сдвинулась вовсе», и рывок вдвое.
    for (let i = 0; i < 5; i++) subsystem.updateFrame(1 / 60, 1);
    const resumed = poseAttribute(subsystem)[0]!;
    expect(resumed - wrapped).toBe(3);
  });

  it('кроссфейд дренируется по модулю: обратный ход его доигрывает, а не вешает', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1)]));
    assets.resolve('model', MODEL_ID, makeModel());
    for (let i = 0; i < 20; i++) subsystem.updateFrame(1 / 60, 1);

    // Смена состояния заводит кроссфейд (0.15 с), и тут же начинается перемотка.
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    for (let i = 0; i < 12; i++) subsystem.updateFrame(-1 / 60, 1);

    // Переход отыгран: пара снова держит соседние кадры ОДНОГО клипа.
    const pose = poseAttribute(subsystem);
    expect(pose[1]! - pose[0]!).toBe(1);
  });

  it('активный one-shot отступает к началу и уступает клипу состояния', () => {
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], {
        freshEvents: true,
        events: [{ type: 'CastFireball', data: { entity: 1 } }],
      }),
    );
    const controller = subsystem.instanceFor(1)!.controller!;
    for (let i = 0; i < 12; i++) subsystem.updateFrame(1 / 60, 1); // 0.2 с из 0.5
    expect(controller.currentClipName).toBe('Attack - 1');

    // Пауза one-shot не снимает: нулевые часы — не «клип доигран».
    for (let i = 0; i < 10; i++) subsystem.updateFrame(0, 1);
    expect(controller.currentClipName).toBe('Attack - 1');

    for (let i = 0; i < 20; i++) subsystem.updateFrame(-1 / 60, 1);
    expect(controller.currentClipName).toBe('Walk Fast');
  });

  it('one-shot, доигранный до перемотки, обратным ходом не воскресает', () => {
    // Паритет ярусов (REND-20): у детального яруса «раз-финишить» клип микшеру
    // нечем (design D5), и батчевый обязан вести себя ТАК ЖЕ, хотя фаза у него
    // своя и вернуть её в клип он бы мог. Одинаковое поведение здесь важнее
    // того, что каждый ярус способен изобразить поодиночке.
    const { subsystem, assets } = makeRig();
    subsystem.syncTick(makeTickView([makeEntityView(1, { moving: true })]));
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.syncTick(
      makeTickView([makeEntityView(1, { moving: true })], {
        freshEvents: true,
        events: [{ type: 'CastFireball', data: { entity: 1 } }],
      }),
    );
    const controller = subsystem.instanceFor(1)!.controller!;
    // Атака (0.5 с) доиграна до конца — вернулись в клип состояния.
    for (let i = 0; i < 42; i++) subsystem.updateFrame(1 / 60, 1);
    expect(controller.currentClipName).toBe('Walk Fast');

    for (let i = 0; i < 60; i++) subsystem.updateFrame(-1 / 60, 1);
    expect(controller.currentClipName).toBe('Walk Fast');
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

    // Возврат к прежним частям возвращает и прежний батч — а он всё это время
    // стоял пустым и правки скинов не видел. Набор вариантов сводится с записью
    // и на этом пути (REND-17): иначе новый скин клампился бы в базовый.
    const back = makeManifest();
    back.entities.Runner!.defaultSkin = 'azure';
    back.entities.Runner!.skins!.azure = { '0': 'tex/azure.png' };
    subsystem.applyManifest(back);
    subsystem.updateFrame(1 / 60, 1);
    expect(subsystem.batchStats()).toMatchObject({ batches: 2, records: 1 });
    // Варианты: базовый, `azure`, `blue`, `red` — умолчательный лежит слоем 1.
    expect(requestCount(assets, 'tex/azure.png')).toBe(1);
    expect(layerOf(subsystem, RUNNER_BATCH, 0)).toBe(1);
  });

  it('переподача манифеста меняет скин батчевой записи', () => {
    // Соседняя запись на той же модели: свой батч (ключ включает запись) и свои
    // варианты — по ней видно, что правка чужих скинов её не трогает.
    const manifest = withNeighbour();
    const { subsystem, assets } = makeRig(manifest);
    subsystem.syncTick(
      makeTickView([makeEntityView(1), makeEntityView(2), makeEntityView(3, { kind: 'Keeper' })]),
    );
    assets.resolve('model', MODEL_ID, makeModel());
    subsystem.setSkin(2, 'blue');
    subsystem.updateFrame(1 / 60, 1);

    const first = subsystem.instanceFor(1)!;
    const second = subsystem.instanceFor(2)!;
    const controller = first.controller!;
    // Варианты записи: базовый, `blue`, `red` — скин записи лежит слоем 2.
    expect(layerOf(subsystem, RUNNER_BATCH, 0)).toBe(2);
    expect(layerOf(subsystem, RUNNER_BATCH, 1)).toBe(1);
    expect(requestCount(assets, 'tex/gold.png')).toBe(1);

    // Фаза клипа отматывается: по ней и видно, пересобрана ли запись (REND-11).
    for (let i = 0; i < 20; i++) subsystem.updateFrame(1 / 60, 1);
    const phase = poseAttribute(subsystem)[0]!;
    expect(phase).toBeGreaterThan(0);

    // Новый вариант в таблице: имя сортируется ПЕРЕД `blue`, и сквозные индексы
    // всех вариантов записи сдвигаются — старый набор клампил бы их в базовый.
    const next = withNeighbour();
    next.entities.Runner!.defaultSkin = 'azure';
    next.entities.Runner!.skins!.azure = { '0': 'tex/azure.png' };
    subsystem.applyManifest(next);
    subsystem.updateFrame(1 / 60, 1);

    // Варианты стали: базовый, `azure`, `blue`, `red`.
    expect(requestCount(assets, 'tex/azure.png')).toBe(1);
    expect(layerOf(subsystem, RUNNER_BATCH, 0)).toBe(1); // невыбранный переехал на новый умолчательный
    expect(layerOf(subsystem, RUNNER_BATCH, 1)).toBe(2); // выбранный поимённо остался синим (REND-11)
    // Пересобран НАБОР ВАРИАНТОВ, а не записи: инстансы, контроллер и фаза те же.
    expect(subsystem.instanceFor(1)).toBe(first);
    expect(subsystem.instanceFor(2)).toBe(second);
    expect(first.controller).toBe(controller);
    expect(poseAttribute(subsystem)[0]!).toBeGreaterThanOrEqual(phase);
    expect(subsystem.batchStats()).toMatchObject({ batches: 2, records: 3 });

    // Правленый путь существующего варианта: пиксели слоя другие — набор
    // перезапрашивается, хотя список имён не изменился.
    const edited = withNeighbour();
    edited.entities.Runner!.defaultSkin = 'azure';
    edited.entities.Runner!.skins!.azure = { '0': 'tex/azure.png' };
    edited.entities.Runner!.skins!.blue = { '0': 'tex/cyan.png' };
    subsystem.applyManifest(edited);
    subsystem.updateFrame(1 / 60, 1);

    expect(requestCount(assets, 'tex/cyan.png')).toBe(1);
    expect(layerOf(subsystem, RUNNER_BATCH, 1)).toBe(2); // тот же слой, другие пиксели

    // Соседняя запись за обе переподачи не тронута: её таблица скинов та же,
    // и перезапрашивать её вариант незачем (REND-17).
    expect(requestCount(assets, 'tex/gold.png')).toBe(1);
    expect(layerOf(subsystem, KEEPER_BATCH, 0)).toBe(1);
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
