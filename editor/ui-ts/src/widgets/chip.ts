/**
 * Чип статуса — короткая пометка рядом с записью: вид объекта, режим, счётчик
 * нарушений.
 *
 * Тона названы состоянием, а не цветом (`active`, а не «оранжевый»), и это не
 * стилистика: ED-22 закрепил акцент за интерактивным состоянием, и тон,
 * названный цветом, рано или поздно окажется на состоянии данных. `active` —
 * включённый инструмент, текущая рабочая область; `error`/`warning`/`info` —
 * состояния данных со своими, не акцентными цветами; `neutral` — пометка,
 * которая вообще не состояние, а свойство записи.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';

export type ChipTone = 'neutral' | 'active' | 'error' | 'warning' | 'info';

export interface ChipSpec {
  readonly label: UiText;
  readonly tone?: ChipTone;
  readonly icon?: IconName;
}

export function statusChip(spec: ChipSpec): UiNode {
  const tone = spec.tone ?? 'neutral';
  return el('span', {
    classes: ['fx-chip', ...(tone === 'neutral' ? [] : [`fx-chip--${tone}`])],
    attrs: { 'data-tone': tone },
    children: children(
      spec.icon === undefined ? undefined : icon({ name: spec.icon }),
      el('span', { text: spec.label }),
    ),
  });
}
