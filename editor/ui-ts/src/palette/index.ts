/**
 * Палитра команд и поиск по проекту (ED-24) — то, чем до объекта, системы,
 * ассета и операции добираются мимо дерева навигатора.
 *
 * Наружу выходит форма вклада-команды, форма находки поиска и сборка строк:
 * доменного знания здесь нет, оно приходит вкладами и машинным каталогом
 * (ED-25, ED-30).
 */
export { matchesQuery, paletteEntries } from './palette.js';
export type {
  CommandTarget,
  PaletteCommand,
  PaletteEntry,
  PaletteEntryKind,
  PaletteSpec,
  SearchHit,
} from './palette.js';
export { PALETTE_CLASS, PALETTE_ROVING_ID, PALETTE_SCRIM_CLASS, paletteView } from './view.js';
export type { PaletteViewSpec } from './view.js';
export { PALETTE_RULES } from './styles.js';
