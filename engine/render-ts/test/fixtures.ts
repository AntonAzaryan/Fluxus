/**
 * Общие фикстуры тестов: нормализованная модель, стаб AssetService с ручным
 * управлением состояниями и конструкторы presentation-состояния.
 */
import * as THREE from 'three';
import { LOCOMOTION_NORMAL, createTerrainGrid, type EntityId, type TerrainGrid } from '@game-mvp/core';
import type {
  AssetKind,
  AssetService,
  AssetState,
  NormalizedModel,
  NormalizedSequence,
} from '@game-mvp/assets';
import type {
  EntityView,
  FogLayerCanvas,
  FogSubsystem,
  RenderContext,
  TickView,
} from '../src/index.js';

// ------------------------------------------------------------------- модель

function sequence(
  name: string,
  duration: number,
  withVisibility = false,
): NormalizedSequence {
  return {
    name,
    duration,
    boneTracks: [
      {
        boneIndex: 1,
        rotation: {
          times: new Float32Array([0, duration]),
          // identity → 90° вокруг Z.
          values: new Float32Array([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
          interpolation: 'linear',
        },
      },
    ],
    partVisibility: withVisibility
      ? [{ partId: 0, times: new Float32Array([0]), visible: new Uint8Array([1]) }]
      : [],
  };
}

/** Мини-модель: два bone (root + chest), один меш-треугольник, четыре секвенции. */
export function makeModel(): NormalizedModel {
  return {
    bones: [
      {
        index: 0,
        name: 'Bone_Root',
        parentIndex: -1,
        position: [1, 2, 3],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
      {
        index: 1,
        name: 'Bone_Chest',
        parentIndex: 0,
        position: [10, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
    ],
    meshes: [
      {
        partId: 0,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: null,
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
        skinIndices: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        materialIndex: 0,
      },
    ],
    sequences: [
      sequence('Stand - 1', 1, true),
      sequence('Walk Fast', 1),
      sequence('Attack - 1', 0.5),
      sequence('Death', 0.8),
      sequence('Roll', 0.6),
      sequence('Jump Loop', 0.7),
      sequence('Fall', 0.9),
    ],
    materials: [
      {
        baseColorFactor: [0.5, 0.5, 0.5, 1],
        baseColorTexture: 0,
        metallicFactor: 0.05,
        roughnessFactor: 0.85,
        normalTexture: null,
        emissiveFactor: [0, 0, 0],
        emissiveTexture: null,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: true,
      },
    ],
    textureSlots: [{ slot: 0, source: 'file', path: 'tex/base.png' }],
    height: 2,
  };
}

// -------------------------------------------------------------- стаб ассетов

export interface AssetsStub {
  readonly service: AssetService;
  /** Все запросы в порядке поступления. */
  readonly requests: { kind: AssetKind; id: string }[];
  resolve(kind: AssetKind, id: string, data: unknown): void;
  fail(kind: AssetKind, id: string, reason: string): void;
  /**
   * Адрес, запрос которого отказывает СИНХРОННО (ASSET-3): ключ реестра — пара
   * «вид + формат», и тот же адрес, уже загруженный под другим видом, — не
   * «ассет недоступен», а брошенное из `request` исключение. Потребитель обязан
   * пережить его предупреждением и пропуском, а не отказом кадра.
   */
  collide(kind: AssetKind, id: string, message: string): void;
}

/** Стаб AssetService: состояния переключаются вручную из теста. */
export function makeAssets(): AssetsStub {
  const requests: { kind: AssetKind; id: string }[] = [];
  const states = new Map<string, AssetState<unknown>>();
  const subscribers = new Map<string, Set<(s: AssetState<unknown>) => void>>();
  const collisions = new Map<string, string>();
  const key = (kind: AssetKind, id: string): string => `${kind}:${id}`;

  const set = (kind: AssetKind, id: string, state: AssetState<unknown>): void => {
    states.set(key(kind, id), state);
    for (const cb of subscribers.get(key(kind, id)) ?? []) cb(state);
  };

  const service = {
    registerLoader(): void {},
    request(kind: AssetKind, id: string) {
      requests.push({ kind, id });
      const collision = collisions.get(key(kind, id));
      if (collision !== undefined) throw new Error(collision);
      if (!states.has(key(kind, id))) states.set(key(kind, id), { status: 'loading' });
      return { id, kind };
    },
    state(handle: { id: string; kind: AssetKind }) {
      return states.get(key(handle.kind, handle.id)) ?? { status: 'loading' };
    },
    subscribe(handle: { id: string; kind: AssetKind }, cb: (s: AssetState<unknown>) => void) {
      const k = key(handle.kind, handle.id);
      let set_ = subscribers.get(k);
      if (set_ === undefined) {
        set_ = new Set();
        subscribers.set(k, set_);
      }
      set_.add(cb);
      // Как настоящий сервис (ASSET-4): подписка немедленно приносит текущее
      // состояние. Без этого стаб «терял» уже готовые ассеты, и потребители,
      // полагающиеся на контракт, тестировались бы в несуществующем мире.
      cb(states.get(k) ?? { status: 'loading' });
      return () => set_.delete(cb);
    },
    retry(): void {},
  } as unknown as AssetService;

  return {
    service,
    requests,
    resolve: (kind, id, data) => { set(kind, id, { status: 'ready', data }); },
    fail: (kind, id, reason) => { set(kind, id, { status: 'failed', reason }); },
    collide: (kind, id, message) => { collisions.set(key(kind, id), message); },
  };
}

// ----------------------------------------------- presentation-состояние

/**
 * Presentation-срез сущности с умолчаниями. Вид манёвра прошлого тика по
 * умолчанию совпадает с текущим: тест, назвавший манёвр, описывает кадр ВНУТРИ
 * него, а переход между видами (и тик приземления) задаётся `prevMotion` явно —
 * иначе каждый такой тест молча проверял бы вход в манёвр.
 */
export function makeEntityView(id: EntityId, partial: Partial<EntityView> = {}): EntityView {
  const view: EntityView = {
    id,
    kind: 'Runner',
    prevX: 0,
    prevY: 0,
    currX: 0,
    currY: 0,
    prevLevel: 0,
    currLevel: 0,
    snap: false,
    spawned: false,
    moving: false,
    levelOverride: false,
    facingYaw: 0,
    aimYaw: null,
    states: 0,
    motion: LOCOMOTION_NORMAL,
    prevMotion: LOCOMOTION_NORMAL,
    prevMotionPhase: Number.NaN,
    currMotionPhase: Number.NaN,
    flightPhase: Number.NaN,
    ...partial,
  };
  return partial.prevMotion === undefined ? { ...view, prevMotion: view.motion } : view;
}

// ------------------------------------------------ стенд тумана войны (FOW-7..10)

/**
 * Записывающий стаб рендерера: подсистеме нужен структурный минимум
 * (`FogRendererLike`), а не живой WebGL. Он же — счётчик вызовов рендерера на
 * стороне теста (`performance-budget` PERF-3, design D2): абстракции WebGL в
 * пакете ради этого не заводится.
 */
export class RendererSpy {
  readonly rendered: THREE.Object3D[] = [];
  readonly targets: (THREE.WebGLRenderTarget | null)[] = [];
  render(scene: THREE.Object3D): void {
    this.rendered.push(scene);
  }
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void {
    this.targets.push(target);
  }
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2 {
    return target.set(64, 48);
  }
}

/** Канвас слоя миникарты без DOM: записывает блит, контекст минимальный. */
export function fakeCanvas(): FogLayerCanvas & { puts: number } {
  const canvas = {
    width: 0,
    height: 0,
    puts: 0,
    getContext: () => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
      putImageData: () => {
        canvas.puts++;
      },
    }),
  };
  return canvas;
}

/**
 * Кадров, за которые перестройка маски обязана опубликоваться. Бюджет по
 * умолчанию укладывает её в три (design D1 change `fog-mask-budgeted-rebuild`);
 * запас взят на вырост, а не на «сколько-нибудь».
 */
const FOG_BUILD_FRAMES = 64;

/**
 * Кадры до публикации маски: доставка растра не строит, его строят порции в
 * `updateFrame` (design D1). `dt` по умолчанию нулевой — рассеивание тогда
 * стоит, и тест видит ровно перестройку. Возвращает число потраченных кадров.
 */
export function buildFogMask(fog: FogSubsystem, dt = 0): number {
  const before = fog.rebuilds;
  for (let frame = 1; frame <= FOG_BUILD_FRAMES; frame++) {
    fog.updateFrame(dt, 0);
    if (fog.rebuilds > before) return frame;
  }
  throw new Error(`маска не опубликована за ${FOG_BUILD_FRAMES} кадров`);
}

/** Фабрика канваса слоя миникарты для опций подсистемы (design D6). */
export function fogCanvasFactory(): (width: number, height: number) => FogLayerCanvas {
  return (width, height) => {
    const canvas = fakeCanvas();
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

/** Контекст подсистемы (REND-8) со сценой и стабом ассетов: тумана он не касается. */
export function makeRenderContext(): RenderContext {
  return {
    scene: new THREE.Scene(),
    assets: {} as AssetService,
    config: { heightStep: 0.6 },
  };
}

/** Ровная арена `size`×`size` по клетке в мировую единицу — укрытий нет. */
export function flatGrid(size = 8): TerrainGrid {
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: 65536,
    levels: Array.from({ length: size }, () => '0'.repeat(size)),
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

/**
 * Арена `size`×`size` с решёткой возвышенных клеток шагом `step`: каждая даёт
 * cliff-отрезки по периметру (TERR-5) — ось «число сегментов укрытий» бенча
 * (`performance-budget` PERF-6). Шаг 0 — ровная арена без укрытий.
 */
export function pillarGrid(size: number, step: number): TerrainGrid {
  const levels = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) =>
      step > 0 && x % step === 0 && y % step === 0 ? '1' : '0',
    ).join(''),
  );
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: 65536,
    levels,
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

export function makeTickView(entities: EntityView[], partial: Partial<TickView> = {}): TickView {
  return {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: false,
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    statNames: [],
    events: [],
    floorBits: null,
    floorChangedCells: [],
    ...partial,
  };
}
