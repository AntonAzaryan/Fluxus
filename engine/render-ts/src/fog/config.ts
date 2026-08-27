/**
 * Конфигурация рендера тумана войны (FOW-10) — ДАННЫЕ, а не механизм: секция
 * `fog` парного presentation-документа (PRES-2), документированные умолчания и
 * их слияние. Живёт отдельно от подсистемы (`subsystems/fog.ts`) по той же
 * причине, по которой политика живёт отдельно от механизма: числа здесь правит
 * дизайнер данными, а подсистема ниже — их потребитель, ничего о балансе
 * картинки не знающий.
 *
 * Потолок пресета качества (QUAL-1) сюда не попадает намеренно: он ограничивает
 * ДЕЙСТВУЮЩЕЕ значение в подсистеме и авторскую секцию не трогает ни байтом.
 */
import type { PresentationFog } from '@fluxus/assets';

/**
 * Действующая конфигурация рендера тумана — секция `fog` с закрытыми дырами.
 * Значения по умолчанию (FOW-10) документированы у полей `DEFAULT_FOG_CONFIG`.
 */
export interface FogRenderConfig {
  /**
   * Время рассеивания тумана, секунды: показанная маска сходится к целевой с
   * этой постоянной, открытие и закрытие зоны — не мгновенный скачок. Ноль —
   * мгновенно (FOW-7, FOW-10).
   */
  readonly dissolveSeconds: number;
  /** Сила затемнения зоны вне видимости, [0, 1] (FOW-7). */
  readonly strength: number;
  /** Тон тумана — во что затемняется кадр. */
  readonly color: string;
  /**
   * Ширина градиента края видимой области, мировые единицы (FOW-7). Той же
   * шириной гаснет свет перед фронтом тени укрытия — кромка видимого одна, и
   * второго числа на неё нет намеренно (`fog/mask.ts`).
   */
  readonly edgeWidth: number;
  /** Коэффициент консервативности reveal-радиуса, (0, 1] (FOW-9). */
  readonly conservatism: number;
  /** Разрешение маски — текселей на мировую единицу (FOW-10). */
  readonly resolution: number;
  /** Длительность fade-out «ушла в туман» в секундах (FOW-8, design D7). */
  readonly fadeSeconds: number;
}

/**
 * Документированные значения по умолчанию (FOW-10): туман работает и без
 * секции `fog`. Подобраны на глаз по демо-арене (design Open Questions) —
 * политика картинки, которую дизайнер правит данными, а не этим файлом.
 */
export const DEFAULT_FOG_CONFIG: FogRenderConfig = Object.freeze({
  dissolveSeconds: 0.25,
  strength: 0.5,
  color: '#0e1420',
  edgeWidth: 2.5,
  conservatism: 0.92,
  resolution: 4,
  fadeSeconds: 0.15,
});

/** Секция документа поверх умолчаний: отсутствующее поле — умолчание (FOW-10). */
export function resolveFogConfig(section?: PresentationFog): FogRenderConfig {
  return {
    strength: section?.strength ?? DEFAULT_FOG_CONFIG.strength,
    color: section?.color ?? DEFAULT_FOG_CONFIG.color,
    edgeWidth: section?.edgeWidth ?? DEFAULT_FOG_CONFIG.edgeWidth,
    conservatism: section?.conservatism ?? DEFAULT_FOG_CONFIG.conservatism,
    resolution: section?.resolution ?? DEFAULT_FOG_CONFIG.resolution,
    fadeSeconds: section?.fadeSeconds ?? DEFAULT_FOG_CONFIG.fadeSeconds,
    dissolveSeconds: section?.dissolveSeconds ?? DEFAULT_FOG_CONFIG.dissolveSeconds,
  };
}
