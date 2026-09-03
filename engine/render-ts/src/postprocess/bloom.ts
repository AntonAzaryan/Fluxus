/**
 * Пирамида bloom (REND-34, design D4): её цели, материалы ступеней и сам ход —
 * порог, даунсемплы вниз, ПРОГРЕССИВНЫЙ АПСЕМПЛ вверх (L-7 аудита 2026-09-03).
 *
 * Живёт отдельно от цепочки (`chain.ts`) по предмету: цепочка знает ПОРЯДОК
 * кадра — список проходов, цели кадра и его конец, — а здесь всё, что нужно
 * одному-единственному из них. Свечение читает сведение из своей униформы, и
 * кадр этот проход не двигает: вершина пирамиды — его выход, а не выход кадра.
 *
 * Полноэкранный проход рисует ЦЕПОЧКА: квад, его сцена и счётчики стоимости
 * принадлежат ей, и второй их копии здесь нет — сюда приходит функция отрисовки
 * (`FullscreenDraw`), одна на всю жизнь пирамиды.
 */
import * as THREE from 'three';
import type { PostRendererLike } from '../types.js';
import { uniformOf } from '../uniforms.js';
import {
  BLOOM_LEVELS,
  bloomUpsampleScale,
  createDownsampleMaterial,
  createThresholdMaterial,
  createUpsampleMaterial,
} from './passes.js';
import { own } from '../footprint.js';

/** Один ярус пирамиды: цель и материалы ступеней вниз и вверх. */
interface BloomLevel {
  readonly target: THREE.WebGLRenderTarget;
  /** Ступень вниз; у вершины её нет — в неё пишет проход порога. */
  readonly material: THREE.ShaderMaterial | null;
  /** Ступень вверх; у самого мелкого яруса её нет — из него только читают. */
  readonly upsample: THREE.ShaderMaterial | null;
}

/** Отрисовка полноэкранного прохода цепочкой: материал на квад и цель. */
export type FullscreenDraw = (
  renderer: PostRendererLike,
  material: THREE.ShaderMaterial,
  target: THREE.WebGLRenderTarget | null,
) => void;

export class BloomPyramid {
  private levels: BloomLevel[] = [];
  private thresholdMaterial: THREE.ShaderMaterial | null = null;
  /**
   * Потолок ширины вершины от пресета качества (QUAL-1, design D5);
   * бесконечность — потолка нет, действует производное от кадра разрешение.
   */
  private ceiling = Number.POSITIVE_INFINITY;

  /**
   * Отрисовка полноэкранного прохода — цепочки: квад, его сцена и счётчики
   * принадлежат ей. Поле, а не параметр-свойство: репозиторий гоняет TypeScript
   * в Node снятием типов, а параметр-свойство им не поддерживается (CLI-8).
   */
  private readonly draw: FullscreenDraw;

  constructor(draw: FullscreenDraw) {
    this.draw = draw;
  }

  /** Цели ярусов — вход тестов и диагностики (REND-34). */
  get targets(): readonly THREE.WebGLRenderTarget[] {
    return this.levels.map((level) => level.target);
  }

  /** Материал прохода порога; `null` — пирамиды в этом кадре ещё не было. */
  get threshold(): THREE.ShaderMaterial | null {
    return this.thresholdMaterial;
  }

  /**
   * Вершина пирамиды и есть свечение кадра: ярусы сложены в неё цепочкой
   * апсемплов (design D4, L-7), и второй текстуры сведению не нужно.
   */
  get top(): THREE.Texture | null {
    return this.levels[0]?.target.texture ?? null;
  }

  /** Потолок разрешения вершины (QUAL-1): `min(производное, потолок)`. */
  applyCeiling(ceiling: number): void {
    if (ceiling === this.ceiling) return;
    this.ceiling = ceiling;
    // Пирамида другого разрешения — другие цели; они заведутся ближайшим кадром.
    this.release();
  }

  /** Действующий порог на живой материал (ED-15): пересборки он не требует. */
  applyThreshold(value: number): void {
    const material = this.thresholdMaterial;
    if (material !== null) uniformOf(material, 'uThreshold').value = value;
  }

  /**
   * Кадр пирамиды (design D4): вершина от текстуры сцены, вниз — даунсемплы,
   * вверх — цепочка апсемплов. Ярусы складываются ПО ДОРОГЕ НАВЕРХ, а не в
   * сведении: мелкий ярус (кадр/32), билинейно растянутый сразу на весь кадр,
   * даёт вокруг яркой точки коробчатую звезду, а не свечение.
   */
  render(
    renderer: PostRendererLike,
    input: THREE.Texture,
    frame: { readonly width: number; readonly height: number },
    values: { readonly threshold: number; readonly radius: number; readonly type: THREE.TextureDataType },
  ): void {
    const levels = this.ensureLevels(frame.width, frame.height, values.type);
    const threshold = this.ensureThreshold(values.threshold);
    uniformOf(threshold, 'tScene').value = input;
    this.draw(renderer, threshold, levels[0]?.target ?? null);
    for (let index = 1; index < levels.length; index++) {
      const level = levels[index];
      const source = levels[index - 1];
      if (level === undefined || source === undefined || level.material === null) continue;
      this.tent(renderer, level.material, source.target, level.target);
    }
    // Наверх: самый мелкий ярус добавляется в следующий за ним, тот — в
    // следующий, и так до вершины. Вклад мелкого яруса — авторская ширина
    // свечения (REND-34), одна и та же на каждой ступени.
    const scale = bloomUpsampleScale(values.radius);
    for (let index = levels.length - 2; index >= 0; index--) {
      const level = levels[index];
      const source = levels[index + 1];
      if (level === undefined || source === undefined || level.upsample === null) continue;
      (level.upsample.uniforms.uScale as { value: number }).value = scale;
      this.tent(renderer, level.upsample, source.target, level.target);
    }
  }

  /** Цели и материалы ступеней (REND-31): их отдаёт и выключение, и снос. */
  release(): void {
    for (const level of this.levels) {
      level.target.dispose();
      level.material?.dispose();
      level.upsample?.dispose();
    }
    this.levels = [];
    this.thresholdMaterial?.dispose();
    this.thresholdMaterial = null;
  }

  /** Один проход тента: источник в униформы, его тексель — в шаг выборки. */
  private tent(
    renderer: PostRendererLike,
    material: THREE.ShaderMaterial,
    source: THREE.WebGLRenderTarget,
    target: THREE.WebGLRenderTarget,
  ): void {
    uniformOf(material, 'tSource').value = source.texture;
    (material.uniforms.uTexel as { value: THREE.Vector2 }).value.set(
      1 / source.width,
      1 / source.height,
    );
    this.draw(renderer, material, target);
  }

  /**
   * Ярусы: вершина вдвое мельче кадра и не крупнее потолка пресета
   * (`min(производное, потолок)`, QUAL-1), каждый следующий вдвое мельче
   * предыдущего. Пропорции кадра держатся: потолок режет обе стороны одним
   * множителем, иначе свечение растягивалось бы по одной оси.
   */
  private ensureLevels(
    width: number,
    height: number,
    type: THREE.TextureDataType,
  ): readonly BloomLevel[] {
    const half = Math.max(1, Math.floor(width / 2));
    const topWidth = Math.max(1, Math.floor(Math.min(half, this.ceiling)));
    const topHeight = Math.max(1, Math.floor((height / 2) * (topWidth / half)));
    const top = this.levels[0]?.target;
    if (top?.width === topWidth && top.height === topHeight) return this.levels;
    this.release();
    const levels: BloomLevel[] = [];
    for (let index = 0; index < BLOOM_LEVELS; index++) {
      const divisor = 2 ** index;
      const target = own(
        'renderTarget',
        'postprocess',
        new THREE.WebGLRenderTarget(
          Math.max(1, Math.floor(topWidth / divisor)),
          Math.max(1, Math.floor(topHeight / divisor)),
          {
            depthBuffer: false,
            type,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
          },
        ),
      );
      levels.push({
        target,
        material: index === 0 ? null : createDownsampleMaterial(),
        upsample: index === BLOOM_LEVELS - 1 ? null : createUpsampleMaterial(),
      });
    }
    this.levels = levels;
    return levels;
  }

  private ensureThreshold(value: number): THREE.ShaderMaterial {
    const existing = this.thresholdMaterial;
    if (existing !== null) return existing;
    const material = createThresholdMaterial(value);
    this.thresholdMaterial = material;
    return material;
  }
}
