/**
 * Слой тумана миникарты (HUD-6, design D6) — вторая половина маски видимости,
 * живущая не в кадре, а в канвасе виджета. Врозь с подсистемой потому, что это
 * разные вещи: там — состояние кадра и пост-проход (FOW-7), здесь — попиксельный
 * блит растра в поверхность, которую приносит сборка.
 *
 * DOM пакет рендера не трогает (REND-19): канвас приходит фабрикой, а его тип
 * здесь — структурный минимум, а не `HTMLCanvasElement`.
 */
import type { RenderCostCounters } from '../cost.js';
import type { FogWorldRect, VisibilityMask } from './mask.js';

/**
 * Слой тумана для миникарты (HUD-6, design D6): стабильный объект «канвас +
 * прямоугольник мира + сила затемнения». Канвас перерисовывается на месте,
 * объект не пересоздаётся — виджет вправе держать ссылку.
 */
export interface FogMinimapLayer {
  readonly canvas: unknown;
  readonly world: FogWorldRect;
  readonly strength: number;
}

/** 2D-поверхность слоя миникарты — структурный минимум `HTMLCanvasElement`. */
export interface FogLayerCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): FogLayerContext | null;
}

/** Структурный минимум контекста: блит ImageData, ничего больше. */
export interface FogLayerContext {
  createImageData(width: number, height: number): {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  };
  putImageData(image: unknown, dx: number, dy: number): void;
}

/** Непрозрачный байт альфы: туман вне видимости кроет тон целиком. */
const OPAQUE = 255;

/**
 * Поверхность слоя миникарты: фабрика канваса, сам канвас, буфер пикселей и
 * стабильный объект, который читает виджет. Без фабрики слоя нет вовсе — маска
 * и пост-проход от этого не зависят.
 */
export class FogMinimapSurface {
  private readonly create: ((width: number, height: number) => FogLayerCanvas) | null;
  private canvas: FogLayerCanvas | null = null;
  private image: ReturnType<FogLayerContext['createImageData']> | null = null;
  /** Тон, вбитый в R/G/B буфера; NaN — буфера ещё нет либо тон сменился. */
  private imageHex = Number.NaN;

  /**
   * Объект, который отдают виджету: канвас и сила читаются геттерами — правка
   * конфига (FOW-10) видна ему без пересоздания объекта.
   */
  readonly layer: FogMinimapLayer;

  constructor(
    world: FogWorldRect,
    strengthOf: () => number,
    create?: (width: number, height: number) => FogLayerCanvas,
  ) {
    this.create = create ?? null;
    const canvasOf = (): unknown => this.canvas;
    this.layer = {
      get canvas(): unknown {
        return canvasOf();
      },
      world,
      get strength(): number {
        return strengthOf();
      },
    };
  }

  /** Есть ли что показывать виджету: канвас заведён первым же блитом. */
  get ready(): boolean {
    return this.canvas !== null;
  }

  /** Растр другого разрешения — другая поверхность: прежнюю не растягиваем. */
  reset(): void {
    this.canvas = null;
    this.image = null;
    this.imageHex = Number.NaN;
  }

  /**
   * Блит маски в канвас (design D6): пиксель — тон тумана с альфой `1 − свет`;
   * силу затемнения виджет применяет сам из того же конфига (HUD-6). Ряды
   * перевёрнуты: у растра ряд 0 — минимальный `y` мира, у канваса — верхняя
   * строка, а миникарта рисует мир `+Y` вверх.
   *
   * Тон приходит sRGB-числом (`THREE.Color#getHex`, кэш подсистемы): канвасу
   * нужны sRGB-байты, а компоненты THREE.Color — рабочее (линейное)
   * пространство, тон брался бы темнее авторского. Числом, а не строкой,
   * намеренно: блит зовётся каждым кадром рассеивания (FOW-7), и парсить цвет
   * заново на каждый вызов — аллокация ни за что.
   */
  blit(
    mask: VisibilityMask,
    shown: Uint8Array,
    hex: number,
    cost: RenderCostCounters | undefined,
  ): void {
    if (this.create === null) return;
    if (this.canvas === null) {
      this.canvas = this.create(mask.width, mask.height);
      this.image = null;
      this.imageHex = Number.NaN;
    }
    const context = this.canvas.getContext('2d');
    if (context === null) return;
    this.image ??= context.createImageData(mask.width, mask.height);
    const image = this.image;
    // Блит идёт по всему растру: та же квадратичная зависимость от разрешения,
    // что у обнуления и загрузки, но в главном потоке и попиксельно (PERF-3).
    // Сток уже прочитан вызывающим — здесь только инкремент, и он стоит ПОСЛЕ
    // отказов выше: без канваса блита не было, и приписывать его нечему.
    if (cost !== undefined) cost.fogMinimapTexels += mask.width * mask.height;
    // Тон постоянен по растру: R/G/B вбиваются один раз на буфер (и заново на
    // смену тона, FOW-10), горячий цикл пишет только альфу — одна запись на
    // тексель вместо четырёх при той же картинке.
    if (this.imageHex !== hex) {
      const r = (hex >> 16) & 0xff;
      const g = (hex >> 8) & 0xff;
      const b = hex & 0xff;
      const data = image.data;
      for (let at = 0; at < data.length; at += 4) {
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
      }
      this.imageHex = hex;
    }
    for (let row = 0; row < mask.height; row++) {
      const source = (mask.height - 1 - row) * mask.width;
      const dest = row * mask.width * 4;
      for (let column = 0; column < mask.width; column++) {
        image.data[dest + column * 4 + 3] = OPAQUE - shown[source + column]!;
      }
    }
    context.putImageData(image, 0, 0);
  }
}
