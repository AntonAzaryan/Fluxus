/**
 * Реестры HUD (design Decision 3, образец — `systems/registry.ts` ядра):
 * виды виджетов, именованные селекторы над доставленным состоянием и
 * именованные действия регистрируются кодом, композиция ссылается на всё
 * по именам. Резолв композиции падает до монтирования и называет неизвестное
 * имя — а не молчит и не ломается на первой доставке.
 */
import type { HudActionDecl } from './actions.js';
import type {
  HudComposition,
  HudCompositionEntry,
  HudParams,
  HudWorldAnchor,
} from './composition.js';
import type { HudDeliveredState } from './delivery.js';
import type { HudWidgetKind } from './widget.js';
import { isHudZone, type HudZoneName } from './zones.js';

/**
 * Именованный селектор — чистая функция над доставленным состоянием (HUD-4):
 * без побочных эффектов и без обращений мимо доставленного состояния. Что
 * вернуть — знает селектор; как показать — виджет.
 */
export type HudSelector = (state: HudDeliveredState) => unknown;

const NO_PARAMS: HudParams = {};

export class HudRegistry {
  private readonly widgets = new Map<string, HudWidgetKind>();
  private readonly selectors = new Map<string, HudSelector>();
  private readonly actions = new Map<string, HudActionDecl>();

  registerWidget(kind: HudWidgetKind): void {
    if (this.widgets.has(kind.name)) {
      throw new Error(`вид виджета "${kind.name}" уже зарегистрирован`);
    }
    this.widgets.set(kind.name, kind);
  }

  registerSelector(name: string, selector: HudSelector): void {
    if (this.selectors.has(name)) {
      throw new Error(`селектор "${name}" уже зарегистрирован`);
    }
    this.selectors.set(name, selector);
  }

  registerAction(name: string, decl: HudActionDecl): void {
    if (this.actions.has(name)) {
      throw new Error(`действие "${name}" уже зарегистрировано`);
    }
    this.actions.set(name, decl);
  }

  widgetKind(name: string): HudWidgetKind {
    const kind = this.widgets.get(name);
    if (kind === undefined) throw new Error(`вид виджета "${name}" не зарегистрирован`);
    return kind;
  }

  selector(name: string): HudSelector {
    const selector = this.selectors.get(name);
    if (selector === undefined) throw new Error(`селектор "${name}" не зарегистрирован`);
    return selector;
  }

  action(name: string): HudActionDecl {
    const decl = this.actions.get(name);
    if (decl === undefined) throw new Error(`действие "${name}" не зарегистрировано`);
    return decl;
  }
}

/** Отрезолвленный биндинг: слот виджета, имя из композиции и сам селектор. */
export interface ResolvedHudBinding {
  readonly slot: string;
  readonly name: string;
  readonly selector: HudSelector;
}

export interface ResolvedHudAction {
  readonly slot: string;
  readonly name: string;
  readonly decl: HudActionDecl;
}

export interface ResolvedHudEntry {
  readonly source: HudCompositionEntry;
  readonly kind: HudWidgetKind;
  readonly zone: HudZoneName;
  readonly params: HudParams;
  readonly bindings: readonly ResolvedHudBinding[];
  readonly actions: readonly ResolvedHudAction[];
  /** Размещение по мировому якорю (HUD-10); нет — виджет живёт в зоне. */
  readonly anchor?: HudWorldAnchor;
}

export interface ResolvedHudComposition {
  readonly entries: readonly ResolvedHudEntry[];
}

/** Контекст ошибки: номер записи и вид виджета — чтобы имя было легко найти. */
function at(index: number, entry: HudCompositionEntry): string {
  return `композиция, запись #${String(index)} (виджет "${entry.widget}")`;
}

function resolveEntry(
  registry: HudRegistry,
  entry: HudCompositionEntry,
  index: number,
): ResolvedHudEntry {
  const where = at(index, entry);
  let kind: HudWidgetKind;
  try {
    kind = registry.widgetKind(entry.widget);
  } catch {
    throw new Error(`${where}: неизвестный вид виджета "${entry.widget}"`);
  }
  if (!isHudZone(entry.zone)) {
    throw new Error(`${where}: неизвестная зона "${entry.zone as string}"`);
  }
  const bindings = Object.entries(entry.bindings ?? {}).map(([slot, name]) => {
    try {
      return { slot, name, selector: registry.selector(name) };
    } catch {
      throw new Error(`${where}: неизвестный селектор "${name}" в слоте "${slot}"`);
    }
  });
  const actions = Object.entries(entry.actions ?? {}).map(([slot, name]) => {
    try {
      return { slot, name, decl: registry.action(name) };
    } catch {
      throw new Error(`${where}: неизвестное действие "${name}" в слоте "${slot}"`);
    }
  });
  const anchor = entry.anchor;
  // Слот якоря обязан быть объявлен биндингом ЭТОЙ записи: иначе сущность
  // указать нечем, и виджет молча висел бы скрытым — ровно та ошибка, которую
  // резолв ловит до монтирования (HUD-4, HUD-10).
  if (anchor !== undefined && !bindings.some((binding) => binding.slot === anchor.entity)) {
    throw new Error(
      `${where}: якорь ссылается на слот "${anchor.entity}", которого нет среди биндингов записи`,
    );
  }
  return {
    source: entry,
    kind,
    zone: entry.zone,
    params: entry.params ?? NO_PARAMS,
    bindings,
    actions,
    ...(anchor !== undefined ? { anchor } : {}),
  };
}

/**
 * Резолв композиции против реестров — целиком и до монтирования (HUD-4):
 * ошибка называет неизвестное имя, слот и запись. Успешный резолв — план
 * монтирования для исполнителя (`runtime.ts`).
 */
export function resolveComposition(
  registry: HudRegistry,
  composition: HudComposition,
): ResolvedHudComposition {
  return { entries: composition.entries.map((entry, i) => resolveEntry(registry, entry, i)) };
}
