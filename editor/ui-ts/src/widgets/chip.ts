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
 *
 * Тон строгости приносит свою иконку сам и не спрашивает вызывающего. Без неё
 * чипы «3» красного и «3» жёлтого различались бы одним оттенком — тем самым
 * различением, которое ED-22 называет неработающим; с ней у каждой строгости
 * своя форма, та же, что в блоке причины.
 */
import { children, el, type UiNode, type UiText } from '../dom/node.js';
import { icon, type IconName } from './icon.js';
import { SEVERITY_ICONS, type ValidationSeverity } from './validation.js';

export type ChipTone = 'neutral' | 'active' | ValidationSeverity;

export interface ChipSpec {
  readonly label: UiText;
  readonly tone?: ChipTone;
  readonly icon?: IconName;
}

function glyph(tone: ChipTone, requested: IconName | undefined): IconName | undefined {
  if (tone === 'neutral' || tone === 'active') return requested;
  return SEVERITY_ICONS[tone];
}

export function statusChip(spec: ChipSpec): UiNode {
  const tone = spec.tone ?? 'neutral';
  const name = glyph(tone, spec.icon);
  return el('span', {
    classes: ['fx-chip', ...(tone === 'neutral' ? [] : [`fx-chip--${tone}`])],
    attrs: { 'data-tone': tone },
    children: children(
      name === undefined ? undefined : icon({ name }),
      el('span', { text: spec.label }),
    ),
  });
}
