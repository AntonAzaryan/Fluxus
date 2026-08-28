/**
 * Полоса здоровья (HUD-4, HUD-8): виджет читает ДОСТАВЛЕННЫЕ статы сущности по
 * ИМЕНАМ из параметров записи композиции — какие компоненты мира за ними стоят,
 * ему неизвестно и знать не положено (HUD-8: имена принадлежат контенту).
 *
 * Стат, не доехавший до HUD (нет в конфигурации сборки либо нет компонента у
 * сущности), даёт ПУСТОЕ состояние: полоса не заполняется, текст — прочерк.
 * Ноль здесь не выдумывается — «нет данных» и «мёртв» обязаны различаться.
 */
import type { HudParams } from '../composition.js';
import { entityStat, type HudEntityView } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { setAttr, setText, toggleClass } from '../dom/render.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const HP_BAR_WIDGET = 'hp-bar';
/** Слот биндинга: сущность, чьё здоровье показывается. */
export const HP_BAR_ENTITY_SLOT = 'entity';
/** Класс-модификатор «данных нет» — по нему же его видит и стиль, и тест. */
export const HP_BAR_EMPTY_CLASS = 'is-empty';

const DEFAULT_STAT = 'hp';
const DEFAULT_MAX_STAT = 'hpMax';
const DEFAULT_EMPTY_TEXT = '—';

function stringParam(params: HudParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** Доля заполнения полосы; null — данных нет (HUD-8). */
function fractionOf(value: number | undefined, max: number | undefined): number | null {
  if (value === undefined || max === undefined || max <= 0) return null;
  const fraction = value / max;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}

class HpBarWidget implements HudWidget {
  private readonly stat: string;
  private readonly maxStat: string;
  private readonly emptyText: string;

  private root: Element | null = null;
  private fill: Element | null = null;
  private text: Element | null = null;

  constructor(params: HudParams) {
    this.stat = stringParam(params, 'stat', DEFAULT_STAT);
    this.maxStat = stringParam(params, 'maxStat', DEFAULT_MAX_STAT);
    this.emptyText = stringParam(params, 'emptyText', DEFAULT_EMPTY_TEXT);
  }

  mount(_actions: HudActionsPort): HudNode {
    return el('div', {
      classes: ['hud-hp-bar', HP_BAR_EMPTY_CLASS],
      attrs: { 'data-fraction': '' },
      ref: (element) => {
        this.root = element;
      },
      children: [
        el('div', {
          classes: ['hud-hp-bar__fill'],
          style: { width: '0%' },
          ref: (element) => {
            this.fill = element;
          },
        }),
        el('span', {
          classes: ['hud-hp-bar__text'],
          text: this.emptyText,
          ref: (element) => {
            this.text = element;
          },
        }),
      ],
    });
  }

  /**
   * Значение — доставленное и только оно (HUD-1): своего состояния у полосы нет,
   * поэтому `update.snap` ей нечего снапать — каждая доставка и так прыгает к
   * доставленному числу (HUD-5).
   */
  update(update: HudUpdate): void {
    const entity = (update.values[HP_BAR_ENTITY_SLOT] ?? null) as HudEntityView | null;
    const value = entityStat(entity, this.stat);
    const max = entityStat(entity, this.maxStat);
    const fraction = fractionOf(value, max);

    if (this.root !== null) {
      toggleClass(this.root, HP_BAR_EMPTY_CLASS, fraction === null);
      setAttr(this.root, 'data-fraction', fraction === null ? '' : fraction.toFixed(3));
    }
    // Ширина — атрибутом стиля, а не через `element.style`: точечная запись
    // одинаково работает и в браузере, и в тесте без DOM (dom/render.ts).
    if (this.fill !== null) {
      setAttr(this.fill, 'style', `width: ${String((fraction ?? 0) * 100)}%`);
    }
    if (this.text !== null) {
      // Прочерк — не только когда доли нет: текст показывает те же две
      // величины, из которых доля и считается, и «данных нет» у них одно (HUD-8).
      setText(
        this.text,
        fraction === null || value === undefined || max === undefined
          ? this.emptyText
          : `${String(Math.round(value))} / ${String(Math.round(max))}`,
      );
    }
  }

  dispose(): void {
    this.root = null;
    this.fill = null;
    this.text = null;
  }
}

/** Вид полосы здоровья — регистрируется в реестре видов (HUD-4). */
export const hpBarKind: HudWidgetKind = {
  name: HP_BAR_WIDGET,
  create: (params) => new HpBarWidget(params),
};
