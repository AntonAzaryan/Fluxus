/**
 * Панель способностей с оверлеем перезарядки (HUD-4, HUD-8, HUD-2).
 *
 * Кнопка — как у `ability-bar`: слот действия называется именем семантического
 * действия (INP-4), и куда он ведёт, знает композиция, а не виджет («кнопка
 * неотличима от клавиши», HUD-2). Сверх этого — оверлей кулдауна: доля
 * затемнения и число секунд.
 *
 * Обе величины ПРОИЗВОДНЫ от доставленного (HUD-8): оставшиеся тики и полная
 * длительность приезжают статами по именам из записи композиции, а секунды
 * считаются из тиков и длительности тика — той, что назвал handshake (SHELL-5)
 * и передала композиция. Своего таймера у виджета нет: он не тикает, а
 * показывает; поэтому и `snap` ему нечего снапать (HUD-5).
 *
 * Стата нет — нет и оверлея: пустое состояние вместо выдуманного нуля.
 */
import type { HudJsonValue, HudParams } from '../composition.js';
import { entityStat, type HudEntityView } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { interactive } from '../host.js';
import { assetIdParam, resolveIcon, type HudIconSource, type HudIconTable } from '../icons.js';
import { setAttr, setText } from '../dom/render.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const COOLDOWNS_WIDGET = 'cooldowns';
/** Слот биндинга: сущность, чьи кулдауны показываются. */
export const COOLDOWNS_ENTITY_SLOT = 'entity';
/** Параметр записи композиции со списком способностей. */
export const COOLDOWNS_ABILITIES_PARAM = 'abilities';

/** Длительность тика по умолчанию — 60 Гц; настоящая приезжает handshake'ом. */
const DEFAULT_TICK_MS = 1000 / 60;
/** Сколько кнопок в ряду, если композиция не сказала иначе. */
const DEFAULT_PER_ROW = 3;

/**
 * Одна способность панели: имя действия (слот действия и подпись), asset ID
 * иконки и ИМЕНА статов, из которых берётся кулдаун (HUD-8). Записи, а не
 * параллельные словари: способность описывается в одном месте.
 */
interface AbilitySpec {
  readonly action: string;
  readonly icon: string;
  /** Имя стата с оставшимися тиками кулдауна; нет — оверлея у кнопки не бывает. */
  readonly stat?: string;
  /** Имя стата с полной длительностью кулдауна; нет — доли затемнения нет. */
  readonly maxStat?: string;
}

/** Модель оверлея одной кнопки — то, что и проверяет тест (не пиксели). */
export interface CooldownModel {
  /** Доля затемнения [0..1]; 0 — способность готова. */
  readonly fraction: number;
  /** Целые секунды до готовности; 0 — готова. */
  readonly seconds: number;
  /** Данных о кулдауне нет вовсе (HUD-8) — оверлей не рисуется. */
  readonly unknown: boolean;
}

function abilitiesFromParams(params: HudParams): readonly AbilitySpec[] {
  const raw = params[COOLDOWNS_ABILITIES_PARAM];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `параметр "${COOLDOWNS_ABILITIES_PARAM}": ожидался непустой список способностей (HUD-4)`,
    );
  }
  return (raw as readonly HudJsonValue[]).map((item, index) => specOf(item, index));
}

function specOf(item: HudJsonValue, index: number): AbilitySpec {
  const where = `параметр "${COOLDOWNS_ABILITIES_PARAM}", элемент #${String(index)}`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new Error(`${where}: ожидался объект { action, icon, stat?, maxStat? }`);
  }
  const record = item as Readonly<Record<string, HudJsonValue>>;
  const action = record.action;
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error(`${where}: "action" — имя семантического действия (INP-4), непустая строка`);
  }
  // Иконка — asset ID дерева контента, а не URL: проверка одна на все виджеты
  // с иконками (`icons.ts`, design Decision 7).
  const icon = assetIdParam(record.icon, `${where}, "icon"`);
  return {
    action,
    icon,
    ...(typeof record.stat === 'string' ? { stat: record.stat } : {}),
    ...(typeof record.maxStat === 'string' ? { maxStat: record.maxStat } : {}),
  };
}

function numberParam(params: HudParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Модель оверлея по доставленным статам (HUD-8): оставшиеся тики → секунды по
 * длительности тика, доля — от полной длительности кулдауна. Нет стата
 * остатка — «данных нет»: ни доли, ни секунд, и ноль не выдумывается.
 */
export function cooldownModel(
  entity: HudEntityView | null,
  ability: AbilitySpec,
  tickMs: number,
): CooldownModel {
  const remaining = entityStat(entity, ability.stat);
  if (remaining === undefined) return { fraction: 0, seconds: 0, unknown: true };
  if (remaining <= 0) return { fraction: 0, seconds: 0, unknown: false };
  const total = entityStat(entity, ability.maxStat);
  // Доли без полной длительности не существует: делить не на что, и рисовать
  // «сколько-то затемнения» значило бы выдумать её (HUD-8).
  const fraction = total === undefined || total <= 0 ? 0 : Math.min(remaining / total, 1);
  return { fraction, seconds: Math.ceil((remaining * tickMs) / 1000), unknown: false };
}

/** Способность панели вместе с её резолвнутой иконкой. */
interface AbilityButton {
  readonly ability: AbilitySpec;
  readonly iconUrl: string;
}

/** Смонтированная кнопка: её элементы для точечных обновлений (HUD-5). */
interface ButtonNodes extends AbilityButton {
  root: Element | null;
  overlay: Element | null;
  seconds: Element | null;
}

class CooldownsWidget implements HudWidget {
  /**
   * Способности панели вместе с иконками: ОДИН список, а не два параллельных
   * массива, — иначе «иконка i-й способности» держалась бы совпадением длин.
   */
  private readonly buttons: readonly AbilityButton[];
  private readonly perRow: number;
  private readonly tickMs: number;

  private actions: HudActionsPort | null = null;
  private nodes: ButtonNodes[] = [];

  constructor(params: HudParams, icons: HudIconSource) {
    const abilities = abilitiesFromParams(params);
    // Иконки резолвятся при создании — до монтирования, как имена композиции:
    // дырка в таблице валит `apply` и называет способность, а не молчит.
    const table: HudIconTable = Object.fromEntries(
      abilities.map((ability) => [ability.action, ability.icon]),
    );
    this.buttons = abilities.map((ability) => ({
      ability,
      iconUrl: resolveIcon(table, icons, ability.action),
    }));
    this.perRow = numberParam(params, 'perRow', DEFAULT_PER_ROW);
    this.tickMs = numberParam(params, 'tickMs', DEFAULT_TICK_MS);
  }

  mount(actions: HudActionsPort): HudNode {
    this.actions = actions;
    this.nodes = this.buttons.map((button) => ({
      ...button,
      root: null,
      overlay: null,
      seconds: null,
    }));
    return el('div', {
      // Сам контейнер указатель не перехватывает — интерактивны только кнопки (HUD-3).
      classes: ['hud-cooldowns'],
      // Число рядов — данные композиции: раскладка панели принадлежит ей, а не
      // коду виджета (HUD-4).
      style: { 'grid-template-columns': `repeat(${String(this.perRow)}, auto)` },
      children: this.nodes.map((node) => this.buttonNode(node)),
    });
  }

  private buttonNode(node: ButtonNodes): HudNode {
    const iconUrl = node.iconUrl;
    return interactive(
      el('button', {
        classes: ['hud-cooldowns__button'],
        attrs: {
          type: 'button',
          'data-ability': node.ability.action,
          title: node.ability.action,
          'data-cooldown': '',
        },
        on: {
          click: () => {
            // Слот действия = имя способности; куда он ведёт — знает композиция.
            this.actions?.trigger(node.ability.action);
          },
        },
        ref: (element) => {
          node.root = element;
        },
        children: [
          el('img', {
            classes: ['hud-cooldowns__icon'],
            attrs: { src: iconUrl, alt: node.ability.action, draggable: 'false' },
          }),
          el('div', {
            classes: ['hud-cooldowns__overlay'],
            style: { '--cooldown': '0' },
            ref: (element) => {
              node.overlay = element;
            },
          }),
          el('span', {
            classes: ['hud-cooldowns__seconds'],
            text: '',
            ref: (element) => {
              node.seconds = element;
            },
          }),
        ],
      }),
    );
  }

  update(update: HudUpdate): void {
    const entity = (update.values[COOLDOWNS_ENTITY_SLOT] ?? null) as HudEntityView | null;
    for (const node of this.nodes) {
      const model = cooldownModel(entity, node.ability, this.tickMs);
      if (node.root !== null) {
        setAttr(
          node.root,
          'data-cooldown',
          model.unknown ? '' : model.fraction.toFixed(3),
        );
      }
      if (node.overlay !== null) {
        // Затемнение — доля в CSS-переменной: как её нарисовать (conic-gradient,
        // clip-path), решает таблица стилей сборки, а не виджет.
        setAttr(node.overlay, 'style', `--cooldown: ${model.fraction.toFixed(3)}`);
      }
      if (node.seconds !== null) {
        setText(node.seconds, model.unknown || model.seconds <= 0 ? '' : String(model.seconds));
      }
    }
  }

  dispose(): void {
    this.actions = null;
    this.nodes = [];
  }
}

/**
 * Вид панели с кулдаунами. Шов иконок — инъекция сборки клиента (HUD-4), как у
 * `ability-bar`: композиция остаётся JSON-значением.
 */
export function cooldownsKind(icons: HudIconSource): HudWidgetKind {
  return {
    name: COOLDOWNS_WIDGET,
    create: (params) => new CooldownsWidget(params, icons),
  };
}
