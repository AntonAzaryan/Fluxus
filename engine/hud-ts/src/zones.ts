/**
 * Фиксированный словарь экранных зон HUD (design Decision 5): композиция
 * раскладывает виджеты по зонам, а не по абсолютным координатам — это и есть
 * переносимость композиции между разрешениями (HUD-4). Порядок в списке —
 * порядок сетки 3×3 хоста: строки сверху вниз, колонки слева направо.
 */
export const HUD_ZONES = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
] as const;

export type HudZoneName = (typeof HUD_ZONES)[number];

/** Runtime-проверка имени зоны: будущий JSON-документ типами TS не защищён. */
export function isHudZone(value: string): value is HudZoneName {
  return (HUD_ZONES as readonly string[]).includes(value);
}
