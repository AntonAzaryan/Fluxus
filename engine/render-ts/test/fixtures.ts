/**
 * Общие фикстуры тестов: нормализованная модель, стаб AssetService с ручным
 * управлением состояниями и конструкторы presentation-состояния.
 */
import { LOCOMOTION_NORMAL, type EntityId } from '@game-mvp/core';
import type {
  AssetKind,
  AssetService,
  AssetState,
  NormalizedModel,
  NormalizedSequence,
} from '@game-mvp/assets';
import type { EntityView, TickView } from '../src/index.js';

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
}

/** Стаб AssetService: состояния переключаются вручную из теста. */
export function makeAssets(): AssetsStub {
  const requests: { kind: AssetKind; id: string }[] = [];
  const states = new Map<string, AssetState<unknown>>();
  const subscribers = new Map<string, Set<(s: AssetState<unknown>) => void>>();
  const key = (kind: AssetKind, id: string): string => `${kind}:${id}`;

  const set = (kind: AssetKind, id: string, state: AssetState<unknown>): void => {
    states.set(key(kind, id), state);
    for (const cb of subscribers.get(key(kind, id)) ?? []) cb(state);
  };

  const service = {
    registerLoader(): void {},
    request(kind: AssetKind, id: string) {
      requests.push({ kind, id });
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
    resolve: (kind, id, data) => set(kind, id, { status: 'ready', data }),
    fail: (kind, id, reason) => set(kind, id, { status: 'failed', reason }),
  };
}

// ----------------------------------------------- presentation-состояние

export function makeEntityView(id: EntityId, partial: Partial<EntityView> = {}): EntityView {
  return {
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
    prevMotionPhase: Number.NaN,
    currMotionPhase: Number.NaN,
    ...partial,
  };
}

export function makeTickView(entities: EntityView[], partial: Partial<TickView> = {}): TickView {
  return {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: false,
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    events: [],
    floorBits: null,
    floorChangedCells: [],
    ...partial,
  };
}
