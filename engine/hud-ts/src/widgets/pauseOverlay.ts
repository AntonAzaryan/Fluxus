/**
 * Оверлей паузы матча (HUD-9): состояние, слот-инициатор и обратный отсчёт
 * возобновления — на ДОСТАВЛЕННОМ состоянии паузы (`netcode-transport` NTR-20)
 * и ни на чём другом.
 *
 * Косвенных признаков виджет не читает и читать не может по построению: ни
 * потока снапшотов, ни номера тика, ни режима мира в его входе нет — только
 * значение слота биндинга. Переставшие приходить доставки и замерший тик — это
 * картина сбоя сети, а не паузы, и оверлей на них MUST NOT появляться (HUD-9).
 *
 * Отсчёт ведётся локальными часами презентации от ДОСТАВЛЕННОЙ длительности
 * (`HudWidget.frame`) и сходится к доставляемым обновлениям, а не заменяет их
 * (HUD-5): каждое новое объявление ставит остаток на объявленное значение, а
 * конец паузы приходит доставкой «идёт», а не истечением местного счётчика.
 * Авторитетен факт возобновления, а не совпадение миллисекунд.
 *
 * Именованный отказ политики показывается игроку, а не теряется (HUD-9): его
 * ключ приезжает вместе с состоянием, а фраза — словарём параметров композиции
 * (HUD-4), потому что смысл причин принадлежит игре, а не виджету.
 */
import type { HudParams } from '../composition.js';
import type { HudDeliveredState, HudPauseState } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { setAttr, setText } from '../dom/render.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const PAUSE_OVERLAY_WIDGET = 'pause-overlay';
/** Слот биндинга: доставленное состояние паузы (NTR-20). */
export const PAUSE_OVERLAY_SLOT = 'pause';

/**
 * Селектор доставленного состояния паузы — чистая функция над доставленным
 * состоянием (HUD-4). Экспортируется рядом с виджетом, как селекторы миникарты:
 * сборка регистрирует его по имени, а второй такой же в игре означал бы второе
 * место, где «нет паузы» может превратиться в «пауза есть».
 */
export const matchPauseSelector = (state: HudDeliveredState): HudPauseState | undefined =>
  state.pause;

/** Сколько держать на экране именованный отказ политики, если композиция не сказала иного. */
const DEFAULT_DENY_HOLD_MS = 4000;

function stringParam(params: HudParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}

function numberParam(params: HudParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Словарь строк из параметров записи композиции: ключ → фраза. Не словарь —
 * пустая таблица, а не отказ: имена причин и слотов принадлежат игре, и
 * композиция без словаря показывает ключ как есть. Это хуже фразы, но честнее
 * молчания — «отказ был, а причину вам не покажут» ровно то, что HUD-9
 * запрещает.
 */
function tableParam(params: HudParams, key: string): Readonly<Record<string, string>> {
  const value = params[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const table: Record<string, string> = {};
  for (const [name, phrase] of Object.entries(value)) {
    if (typeof phrase === 'string') table[name] = phrase;
  }
  return table;
}

function listParam(params: HudParams, key: string): readonly string[] {
  const value = params[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

class PauseOverlayWidget implements HudWidget {
  private readonly title: string;
  private readonly byLabel: string;
  private readonly resumingLabel: string;
  private readonly serverLabel: string;
  private readonly slotNames: readonly string[];
  private readonly denyLabels: Readonly<Record<string, string>>;
  private readonly denyHoldMs: number;

  private root: Element | null = null;
  private titleElement: Element | null = null;
  private byElement: Element | null = null;
  private countdownElement: Element | null = null;
  private deniedElement: Element | null = null;

  /** Последнее доставленное состояние; `null` — паузы не доставляли (HUD-9). */
  private pause: HudPauseState | null = null;
  /** Остаток отсчёта по местным часам, мс: ставится доставкой, убывает кадром. */
  private remainingMs = 0;
  /** Показанный отказ и его номер: повтор той же причины перезапускает показ. */
  private deniedKey: string | null = null;
  private deniedSeq = 0;
  private deniedHeldMs = 0;

  constructor(params: HudParams) {
    this.title = stringParam(params, 'title', 'Пауза');
    this.byLabel = stringParam(params, 'byLabel', 'поставил');
    this.resumingLabel = stringParam(params, 'resumingLabel', 'Возобновление через');
    this.serverLabel = stringParam(params, 'serverLabel', 'сервер');
    this.slotNames = listParam(params, 'slotNames');
    this.denyLabels = tableParam(params, 'denyLabels');
    this.denyHoldMs = numberParam(params, 'denyHoldMs', DEFAULT_DENY_HOLD_MS);
  }

  mount(_actions: HudActionsPort): HudNode {
    return el('div', {
      classes: ['hud-pause'],
      // Скрыт до первой доставки: пустой оверлей поверх боя — та же неправда,
      // что оверлей без доставленной паузы.
      style: { display: 'none' },
      ref: (element) => {
        this.root = element;
      },
      children: [
        el('div', {
          classes: ['hud-pause__title'],
          text: this.title,
          ref: (element) => {
            this.titleElement = element;
          },
        }),
        el('div', {
          classes: ['hud-pause__by'],
          ref: (element) => {
            this.byElement = element;
          },
        }),
        el('div', {
          classes: ['hud-pause__countdown'],
          ref: (element) => {
            this.countdownElement = element;
          },
        }),
        el('div', {
          classes: ['hud-pause__denied'],
          ref: (element) => {
            this.deniedElement = element;
          },
        }),
      ],
    });
  }

  /**
   * Доставка (HUD-5): состояние берётся целиком, местный отсчёт ставится на
   * объявленную длительность. Смонтированная композиция без доставленной паузы
   * оверлея не рисует — значение слота там `undefined`, и это ОТВЕТ, а не
   * отсутствие ответа.
   */
  update(update: HudUpdate): void {
    const pause = update.values[PAUSE_OVERLAY_SLOT] as HudPauseState | undefined;
    if (pause === undefined) {
      this.render();
      return;
    }
    this.pause = pause;
    // Местный отсчёт СХОДИТСЯ к доставленному, а не идёт сам по себе (HUD-9):
    // каждое объявление ставит остаток на объявленную длительность.
    this.remainingMs = pause.state === 'resuming' ? pause.countdownMs : 0;
    if (pause.denied !== undefined && pause.deniedSeq !== this.deniedSeq) {
      this.deniedSeq = pause.deniedSeq;
      this.deniedKey = pause.denied;
      this.deniedHeldMs = 0;
    }
    this.render();
  }

  /**
   * Кадр главного потока: только местный отсчёт и срок показа отказа. Мирового
   * состояния в этом вызове нет и быть не может — мир виджет наблюдает каденсом
   * доставки (HUD-5), и `dt` здесь секунды САМОГО потока (`HudWidget.frame`).
   */
  frame(dt: number): void {
    const ms = dt * 1000;
    let changed = false;
    if (this.remainingMs > 0) {
      // Ниже нуля отсчёт не уходит: конец паузы объявляет сервер доставкой
      // «идёт», а истёкший местный счётчик означает лишь «вот-вот».
      this.remainingMs = Math.max(0, this.remainingMs - ms);
      changed = true;
    }
    if (this.deniedKey !== null) {
      this.deniedHeldMs += ms;
      if (this.deniedHeldMs >= this.denyHoldMs) {
        this.deniedKey = null;
        changed = true;
      }
    }
    if (changed) this.render();
  }

  dispose(): void {
    this.root = null;
    this.titleElement = null;
    this.byElement = null;
    this.countdownElement = null;
    this.deniedElement = null;
  }

  /** Кто поставил: имя слота из композиции, `-1` — сервер, безымянный слот — номером. */
  private initiator(slot: number): string {
    if (slot < 0) return this.serverLabel;
    return this.slotNames[slot] ?? String(slot);
  }

  private render(): void {
    if (this.root === null) return;
    const pause = this.pause;
    const frozen = pause !== null && pause.state !== 'running';
    const denied = this.deniedKey;
    // Оверлея нет вовсе, пока нечего показывать: ни заморозки, ни отказа.
    setAttr(this.root, 'style', frozen || denied !== null ? null : 'display: none');

    if (this.titleElement !== null) {
      setAttr(this.titleElement, 'style', frozen ? null : 'display: none');
      setText(this.titleElement, this.title);
    }
    if (this.byElement !== null) {
      setAttr(this.byElement, 'style', frozen ? null : 'display: none');
      setText(this.byElement, frozen ? `${this.byLabel}: ${this.initiator(pause.slot)}` : '');
    }
    if (this.countdownElement !== null) {
      const resuming = pause !== null && pause.state === 'resuming';
      setAttr(this.countdownElement, 'style', resuming ? null : 'display: none');
      setText(
        this.countdownElement,
        resuming ? `${this.resumingLabel} ${String(Math.ceil(this.remainingMs / 1000))}` : '',
      );
    }
    if (this.deniedElement !== null) {
      setAttr(this.deniedElement, 'style', denied === null ? 'display: none' : null);
      setText(this.deniedElement, denied === null ? '' : (this.denyLabels[denied] ?? denied));
    }
  }
}

/** Вид оверлея паузы — регистрируется в реестре видов (HUD-4, HUD-9). */
export const pauseOverlayKind: HudWidgetKind = {
  name: PAUSE_OVERLAY_WIDGET,
  create: (params) => new PauseOverlayWidget(params),
};
