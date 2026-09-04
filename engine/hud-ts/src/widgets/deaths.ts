/**
 * Счётчики смертей по игрокам (HUD-4, HUD-8).
 *
 * Специального канала под счёт нет и не нужно: и слот игрока, и число смертей —
 * обычные доставленные статы (HUD-8), объявленные конфигурацией сборки. Виджет
 * складывает их в строку «слот: смерти», сортируя по слоту, — порядок обхода
 * доставленных сущностей на картинку не влияет.
 *
 * **Строка — на СЛОТ, а не на сущность.** Единица счёта здесь игрок, и слот —
 * его имя; сколько сущностей доставки этот слот носят, виджету знать нечего.
 * Носителей у одного слота бывает много и по совершенно законным причинам: в
 * сцене демо `Player.slot` — ещё и поле команды платформы способностей
 * (`abilityRuntime.teamField`), поэтому его несут и босс, и каждый его юнит, и
 * строка на сущность давала бы «слот 2» столько раз, сколько живых юнитов в
 * кадре. Схлопывание по слоту — не косметика: без него ОБЕЩАНИЕ выше («порядок
 * обхода на картинку не влияет») перестаёт выполняться, потому что порядок
 * одинаковых строк наблюдаем.
 *
 * Число смертей слота — МАКСИМУМ доставленных значений его носителей: счётчик
 * смертей монотонен, максимум не зависит от порядка обхода, и носитель без
 * стата (юнит, у которого компонента-источника нет) числа слота не гасит.
 *
 * Пока геймплейная система счёт не ведёт, стата смертей у сущностей нет: виджет
 * показывает прочерк — «нет данных», а не ноль убийств.
 */
import type { HudParams } from '../composition.js';
import { entityStat, type HudEntityView } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { renderInto } from '../dom/render.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const DEATHS_WIDGET = 'deaths';
/** Слот биндинга: все доставленные сущности (скрытых в них нет по построению). */
export const DEATHS_ENTITIES_SLOT = 'entities';

const DEFAULT_SLOT_STAT = 'slot';
const DEFAULT_DEATHS_STAT = 'deaths';
const DEFAULT_EMPTY_TEXT = '—';

function stringParam(params: HudParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Строка счётчика: слот игрока и его смерти; `null` — данных о смертях нет. */
export interface DeathsRow {
  readonly slot: number;
  readonly deaths: number | null;
}

/** Модель виджета из доставленного состояния — её и проверяет тест. */
export function deathsRows(
  entities: ReadonlyMap<number, HudEntityView> | undefined,
  slotStat: string,
  deathsStat: string,
): readonly DeathsRow[] {
  // Ключ — слот, а не сущность: строка счётчика принадлежит игроку, и второй
  // носитель того же слота новой строки не заводит.
  const bySlot = new Map<number, number | null>();
  for (const entity of (entities ?? new Map<number, HudEntityView>()).values()) {
    const slot = entityStat(entity, slotStat);
    if (slot === undefined) continue; // не игрок — счётчика у него нет
    const deaths = entityStat(entity, deathsStat);
    const known = bySlot.get(slot);
    if (known === undefined) {
      bySlot.set(slot, deaths ?? null);
      continue;
    }
    if (deaths === undefined) continue; // носитель без стата числа слота не гасит
    bySlot.set(slot, known === null ? deaths : Math.max(known, deaths));
  }
  const rows: DeathsRow[] = [];
  for (const [slot, deaths] of bySlot) rows.push({ slot, deaths });
  rows.sort((left, right) => left.slot - right.slot);
  return rows;
}

class DeathsWidget implements HudWidget {
  private readonly slotStat: string;
  private readonly deathsStat: string;
  private readonly emptyText: string;

  private root: Element | null = null;
  /** Последняя показанная модель: DOM переписывается только при изменении. */
  private shown = '';

  constructor(params: HudParams) {
    this.slotStat = stringParam(params, 'slotStat', DEFAULT_SLOT_STAT);
    this.deathsStat = stringParam(params, 'deathsStat', DEFAULT_DEATHS_STAT);
    this.emptyText = stringParam(params, 'emptyText', DEFAULT_EMPTY_TEXT);
  }

  mount(_actions: HudActionsPort): HudNode {
    return el('div', {
      classes: ['hud-deaths'],
      ref: (element) => {
        this.root = element;
      },
    });
  }

  update(update: HudUpdate): void {
    const entities = update.values[DEATHS_ENTITIES_SLOT] as
      | ReadonlyMap<number, HudEntityView>
      | undefined;
    const rows = deathsRows(entities, this.slotStat, this.deathsStat);
    // Ключ сравнения — сама модель: набор игроков меняется редко, и переписывать
    // поддерево на каждую доставку незачем (HUD-5, Risks).
    const key = rows.map((row) => `${String(row.slot)}:${row.deaths ?? '?'}`).join('|');
    if (key === this.shown || this.root === null) return;
    this.shown = key;
    renderInto(
      this.root,
      el('div', {
        classes: ['hud-deaths__rows'],
        children: rows.map((row) => this.rowNode(row)),
      }),
    );
  }

  private rowNode(row: DeathsRow): HudNode {
    return el('span', {
      classes: ['hud-deaths__row'],
      attrs: { 'data-slot': String(row.slot) },
      text: row.deaths === null ? this.emptyText : String(Math.round(row.deaths)),
    });
  }

  dispose(): void {
    this.root = null;
    this.shown = '';
  }
}

/** Вид счётчиков смертей — регистрируется в реестре видов (HUD-4). */
export const deathsKind: HudWidgetKind = {
  name: DEATHS_WIDGET,
  create: (params) => new DeathsWidget(params),
};
