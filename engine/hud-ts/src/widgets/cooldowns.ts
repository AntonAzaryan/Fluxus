/**
 * Панель способностей с оверлеем перезарядки (HUD-4, HUD-8, HUD-2).
 *
 * Кнопка — как у `ability-bar`: слот действия называется именем семантического
 * действия (INP-4), и куда он ведёт, знает композиция, а не виджет («кнопка
 * неотличима от клавиши», HUD-2). Сверх этого — оверлей кулдауна: доля
 * затемнения и число секунд.
 *
 * Форма органа управления — запись композиции, а не догадка виджета (HUD-2):
 * `hold: true` делает кнопку УДЕРЖИВАЕМОЙ (взятие по `pointerdown`, отпускание
 * по `pointerup`, уводу указателя и отмене жеста), прочие кнопки остаются
 * фронтом по `click`. Смысла способности виджет не знает — он знает форму, как
 * знает иконку и имена статов.
 *
 * Иконка приезжает РАЗДЕЛЯЕМЫМ сервисом ассетов (HUD-4, `icons.ts`): asset ID
 * из записи → байты → `src`. Асинхронно, поэтому состояние иконки видно
 * атрибутом `data-icon` (`loading`/`ready`/`failed`): «файла нет» обязано быть
 * заметно, а не выглядеть пустой кнопкой.
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
import { assetIdParam, iconAssetId, type HudIcons, type HudIconTable } from '../icons.js';
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
  /**
   * Форма органа управления (HUD-2): `true` — кнопка удерживается, иначе фронт
   * по клику. Умолчание — фронт: так работает большинство способностей, и
   * запись без слова о форме описывает именно его.
   */
  readonly hold: boolean;
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
  if (record.hold !== undefined && typeof record.hold !== 'boolean') {
    throw new Error(`${where}: "hold" — форма органа управления (HUD-2), булево значение`);
  }
  return {
    action,
    icon,
    hold: record.hold === true,
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

/** Способность панели вместе с asset ID её иконки (HUD-4). */
interface AbilityButton {
  readonly ability: AbilitySpec;
  readonly iconAsset: string;
}

/** Смонтированная кнопка: её элементы для точечных обновлений (HUD-5). */
interface ButtonNodes extends AbilityButton {
  root: Element | null;
  icon: Element | null;
  overlay: Element | null;
  seconds: Element | null;
  /** Состояние иконки — `loading`/`ready`/`failed`, видно атрибутом `data-icon`. */
  iconStatus: string;
  /** `src` приехавшей иконки; null — ещё не приехала или не приедет. */
  iconSrc: string | null;
}

class CooldownsWidget implements HudWidget {
  /**
   * Способности панели вместе с asset ID иконок: ОДИН список, а не два
   * параллельных массива, — иначе «иконка i-й способности» держалась бы
   * совпадением длин.
   */
  private readonly buttons: readonly AbilityButton[];
  private readonly perRow: number;
  private readonly tickMs: number;
  private readonly icons: HudIcons;

  private actions: HudActionsPort | null = null;
  private nodes: ButtonNodes[] = [];
  /** Отписки от состояний иконок (ASSET-4) — снимаются на `dispose`. */
  private iconSubs: (() => void)[] = [];
  /** Что кнопки держат прямо сейчас (HUD-2): снимается на `dispose` (INP-5). */
  private readonly held = new Set<string>();

  constructor(params: HudParams, icons: HudIcons) {
    const abilities = abilitiesFromParams(params);
    // Asset ID иконок резолвятся при создании — до монтирования, как имена
    // композиции: дырка в таблице валит `apply` и называет способность, а не
    // молчит. Сами байты приезжают сервисом ассетов уже после (HUD-4).
    const table: HudIconTable = Object.fromEntries(
      abilities.map((ability) => [ability.action, ability.icon]),
    );
    this.buttons = abilities.map((ability) => ({
      ability,
      iconAsset: iconAssetId(table, ability.action),
    }));
    this.perRow = numberParam(params, 'perRow', DEFAULT_PER_ROW);
    this.tickMs = numberParam(params, 'tickMs', DEFAULT_TICK_MS);
    this.icons = icons;
  }

  mount(actions: HudActionsPort): HudNode {
    this.actions = actions;
    this.nodes = this.buttons.map((button) => ({
      ...button,
      root: null,
      icon: null,
      overlay: null,
      seconds: null,
      iconStatus: 'loading',
      iconSrc: null,
    }));
    const node = el('div', {
      // Сам контейнер указатель не перехватывает — интерактивны только кнопки (HUD-3).
      classes: ['hud-cooldowns'],
      // Число рядов — данные композиции: раскладка панели принадлежит ей, а не
      // коду виджета (HUD-4).
      style: { 'grid-template-columns': `repeat(${String(this.perRow)}, auto)` },
      children: this.nodes.map((button) => this.buttonNode(button)),
    });
    // Подписки — ПОСЛЕ сборки описания: закэшированный ассет отдаёт состояние
    // синхронно из `subscribe` (ASSET-4), и элементы к тому моменту ещё не
    // материализованы. Поэтому состояние сначала пишется в запись кнопки, а на
    // элементы попадает либо тут же (если они уже есть), либо из `ref`.
    for (const button of this.nodes) this.subscribeIcon(button);
    return node;
  }

  /** Состояние иконки → запись кнопки и, если элементы уже есть, в DOM. */
  private subscribeIcon(node: ButtonNodes): void {
    this.iconSubs.push(
      this.icons.subscribe(node.iconAsset, (state) => {
        node.iconStatus = state.status;
        node.iconSrc = state.status === 'ready' ? state.data.src : null;
        this.applyIcon(node);
      }),
    );
  }

  private applyIcon(node: ButtonNodes): void {
    if (node.root !== null) setAttr(node.root, 'data-icon', node.iconStatus);
    if (node.icon !== null && node.iconSrc !== null) setAttr(node.icon, 'src', node.iconSrc);
  }

  /**
   * Обработчики кнопки по её форме (HUD-2). Удерживаемая кнопка `click` не
   * слушает вовсе: `click` рождается на отпускании, и вместе с `pointerdown`
   * он дал бы два фронта на одно нажатие.
   */
  private buttonHandlers(node: ButtonNodes): Readonly<Record<string, () => void>> {
    const slot = node.ability.action;
    if (!node.ability.hold) {
      // Слот действия = имя способности; куда он ведёт — знает композиция.
      return { click: () => { this.actions?.trigger(slot); } };
    }
    const release = (): void => {
      if (!this.held.delete(slot)) return;
      this.actions?.release(slot);
    };
    return {
      pointerdown: () => {
        if (this.held.has(slot)) return;
        // Сначала фасад, потом учёт: если объявление действия не той формы и
        // фасад бросил, держать виджету нечего (HUD-2).
        this.actions?.hold(slot);
        this.held.add(slot);
      },
      // Отпускание ловится тремя способами: штатное, увод указателя с зажатой
      // кнопки и отмена жеста системой. Без двух последних бит остался бы
      // зажатым до конца матча (INP-5).
      pointerup: release,
      pointerleave: release,
      pointercancel: release,
    };
  }

  private buttonNode(node: ButtonNodes): HudNode {
    return interactive(
      el('button', {
        classes: ['hud-cooldowns__button'],
        attrs: {
          type: 'button',
          'data-ability': node.ability.action,
          title: node.ability.action,
          'data-cooldown': '',
          // Форма кнопки видна в разметке: по ней стиль сборки вправе показать
          // удерживаемую кнопку иначе, а тест — проверить форму без клика.
          'data-form': node.ability.hold ? 'hold' : 'press',
          'data-icon': node.iconStatus,
        },
        on: this.buttonHandlers(node),
        ref: (element) => {
          node.root = element;
          this.applyIcon(node);
        },
        children: [
          el('img', {
            classes: ['hud-cooldowns__icon'],
            // `src` не ставится описанием: иконка приезжает сервисом ассетов и
            // проставляется по готовности (HUD-4).
            attrs: { alt: node.ability.action, draggable: 'false' },
            ref: (element) => {
              node.icon = element;
              this.applyIcon(node);
            },
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

  /**
   * Снятие виджета отпускает всё, что он держал (HUD-2, INP-5): удержания
   * собираются опросом источника каждую выборку, и бит несмонтированной кнопки
   * иначе стоял бы в маске до конца сессии.
   */
  dispose(): void {
    for (const slot of this.held) this.actions?.release(slot);
    this.held.clear();
    for (const unsubscribe of this.iconSubs) unsubscribe();
    this.iconSubs = [];
    this.actions = null;
    this.nodes = [];
  }
}

/**
 * Вид панели с кулдаунами. Иконки — РАЗДЕЛЯЕМЫЙ сервис ассетов сборки (HUD-4,
 * HUD-7): композиция остаётся JSON-значением с asset ID, а байты приходят тем
 * же путём, что модели арены.
 */
export function cooldownsKind(icons: HudIcons): HudWidgetKind {
  return {
    name: COOLDOWNS_WIDGET,
    create: (params) => new CooldownsWidget(params, icons),
  };
}
