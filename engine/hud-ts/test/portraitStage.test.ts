/**
 * THREE-стенд портрета (HUD-7, design Decision 8) — та его часть, которой WebGL
 * не нужен.
 *
 * Настоящий контекст нужен стенду ровно в одном месте — `attach`: рендерер
 * заводится там и только там, а до первой поверхности стенд полноценно живёт с
 * `renderer === null`. Всё, что он делает с моделью — сборка тем же
 * `render-ts`, скин через ОБЩИЙ asset-сервис, клип по таблице манифеста,
 * кадрирование и освобождение СВОИХ ресурсов, — идёт до всякого canvas, и
 * проверяется здесь без браузера.
 *
 * Цикл кадра при этом не крутится и крутиться не может: `requestAnimationFrame`
 * в Node нет, и стенд это прямо проверяет (`ensureLoop`). Поэтому предмет
 * проверки — не картинка, а владение: что стенд просит у общего кэша, что
 * освобождает сам и о чём жалуется сборке.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssetService,
  type DecodedImage,
  type EntityVisual,
  type NormalizedModel,
  type NormalizedSequence,
} from '@fluxus/assets';
import { createThreePortraitStage } from '../src/portrait/threeStage.js';
import type { PortraitStage } from '../src/portrait/stage.js';

const SKIN = 'visuals/textures/hero.png';

function sequence(name: string): NormalizedSequence {
  return { name, duration: 1, boneTracks: [], partVisibility: [] };
}

/** Мини-модель стенда: одна кость, один меш-треугольник, один слот текстуры. */
function stageModel(): NormalizedModel {
  return {
    bones: [
      {
        index: 0,
        name: 'Bone_Root',
        parentIndex: -1,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
    ],
    meshes: [
      {
        partId: 0,
        positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 4]),
        normals: null,
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        indices: new Uint16Array([0, 1, 2]),
        skinIndices: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        skinWeights: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        materialIndex: 0,
      },
    ],
    sequences: [sequence('Stand - 1'), sequence('Walk Fast')],
    materials: [
      {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: 0,
        metallicFactor: 0,
        roughnessFactor: 1,
        normalTexture: null,
        emissiveFactor: [0, 0, 0],
        emissiveTexture: null,
        emissiveStrength: 1,
        alphaMode: 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
      },
    ],
    textureSlots: [{ slot: 0, source: 'file', path: SKIN }],
    height: 4,
  };
}

const HERO: EntityVisual = { model: 'visuals/models/hero.mdx', animations: { states: { idle: 'Stand' } } };

const PIXEL: DecodedImage = { width: 1, height: 1, format: 'rgba8', pixels: Uint8Array.from([1, 2, 3, 4]) };

interface Bench {
  readonly stage: PortraitStage;
  /** Всё, что стенд попросил у дерева контента, в порядке обращения. */
  readonly reads: string[];
  readonly warnings: string[];
}

/**
 * Настоящий `AssetService` над считающим источником: кэш по ID и handle —
 * настоящие (ASSET-2), заглушка только на месте декодера картинки.
 */
function bench(): Bench {
  const reads: string[] = [];
  const warnings: string[] = [];
  const assets = new AssetService({
    read: (id: string) => {
      reads.push(id);
      return Promise.resolve(new ArrayBuffer(0));
    },
  });
  assets.registerLoader({ kind: 'texture', extensions: ['.png'], load: () => PIXEL });
  const stage = createThreePortraitStage({ assets, warn: (message) => warnings.push(message) });
  return { stage, reads, warnings };
}

/** Ждём микрозадачи загрузки ассета: read → load → уведомление подписчиков. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('стенд портрета берёт текстуры из общего кэша (HUD-7, ASSET-2)', () => {
  it('скин просится через тот же asset-сервис, и второй показ не грузит его заново', async () => {
    const { stage, reads } = bench();

    stage.showModel(stageModel(), HERO);
    await flush();
    expect(reads).toEqual([SKIN]);

    // Тот же скин второй раз: сервис общий с ареной, и уже загруженное приходит
    // из кэша тем же handle — повторной загрузки нет (ASSET-2).
    stage.showModel(stageModel(), HERO);
    await flush();
    expect(reads).toEqual([SKIN]);
    stage.dispose();
  });
});

/**
 * Владение THREE-сборкой (шапка `threeStage.ts`, REND-3): геометрия и материалы
 * принадлежат КОНТЕКСТУ рендера, поэтому стенд владеет своими и освобождает их
 * сам — в отличие от подсистемы моделей арены, чей кэш живёт дольше инстанса.
 * Утечка здесь не видна ни typecheck'ом, ни глазами: картинка та же.
 */
describe('стенд освобождает свою THREE-сборку (HUD-7, REND-3)', () => {
  it('смена модели освобождает прежнюю сборку, а не копит её в мини-сцене', () => {
    const geometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const material = vi.spyOn(THREE.Material.prototype, 'dispose');
    const { stage } = bench();

    stage.showModel(stageModel(), HERO);
    expect(geometry).not.toHaveBeenCalled();

    stage.showModel(stageModel(), HERO);
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
    stage.dispose();
  });

  it('снятие модели освобождает сборку, а повторное снятие ничего не ломает', () => {
    const geometry = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const { stage } = bench();

    stage.showModel(stageModel(), HERO);
    stage.clearModel();
    expect(geometry).toHaveBeenCalled();

    // Пустой стенд снимают повторно — например, тем же путём, каким виджет
    // гасит портрет исчезнувшей сущности.
    const after = geometry.mock.calls.length;
    stage.clearModel();
    expect(geometry.mock.calls).toHaveLength(after);
    stage.dispose();
  });

  it('после dispose стенд не показывает и не грузит ничего', async () => {
    const { stage, reads } = bench();
    stage.dispose();
    // Идемпотентность: `dispose` виджета вправе прийти дважды.
    stage.dispose();

    stage.showModel(stageModel(), HERO);
    await flush();
    expect(reads).toEqual([]);
  });
});

describe('idle-клип берётся из таблицы манифеста (HUD-7, REND-4)', () => {
  it('запись, не совпавшая ни с одним клипом, жалуется в сток сборки', () => {
    const { stage, warnings } = bench();
    // Клипа "Танец" у модели нет: контроллер обязан назвать запись и оставить
    // позу покоя, а не подставить произвольный клип (REND-4).
    stage.showModel(stageModel(), { model: HERO.model, animations: { states: { idle: 'Танец' } } });
    expect(warnings.join('\n')).toContain('"Танец"');
    stage.dispose();
  });

  it('разрешимая запись проходит молча, как и запись без idle вовсе', () => {
    const { stage, warnings } = bench();
    stage.showModel(stageModel(), HERO);
    // Запись манифеста без 'idle' оставляет позу покоя БЕЗ предупреждений:
    // отсутствие таблицы — законное состояние, а не опечатка.
    stage.showModel(stageModel(), { model: HERO.model });
    expect(warnings).toEqual([]);
    stage.dispose();
  });
});
