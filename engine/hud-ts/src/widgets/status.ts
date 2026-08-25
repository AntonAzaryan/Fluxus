/**
 * Виджет статуса матча (задача 5.1): тик, режим мира и признак паузы — из
 * доставленного состояния, кнопка паузы/продолжения — действием обратного
 * канала (HUD-2, сценарий «Пауза из HUD»).
 *
 * Тик и режим виджет читает из конверта обновления (`HudUpdate.tick`/`.mode`):
 * исполнитель заполняет их из того же доставленного состояния, что и значения
 * селекторов (`runtime.ts`), — отдельный биндинг был бы вторым именем того же
 * поля. Клик по кнопке шлёт команду и не трогает отображение — исход мирового
 * действия HUD наблюдает в доставленном состоянии, а не изображает сам (HUD-2).
 *
 * Источников «пауза стоит» два, и это не дублирование, а два РАЗНЫХ факта.
 *
 * - Доставленный режим мира (`update.mode`) — заморозка СВОЕЙ машины состояний
 *   (WSM-1): им живёт локальная сборка, у которой сервера нет вовсе.
 * - Доставленное состояние паузы МАТЧА (слот `pauseState`, `netcode-transport`
 *   NTR-20) — им живёт сетевая: в заморозке сервер живых тиков не исполняет и
 *   снапшотов не рассылает, поэтому `update.mode` остаётся тем, каким был до
 *   паузы — `Running`. Кнопка, выбирающая команду по нему, в сетевом матче не
 *   смогла бы послать `resume` НИКОГДА: поставивший паузу жал бы «Пауза» и
 *   получал `already-frozen`, то есть HUD-9 («запрос паузы И СНЯТИЯ уходит
 *   обратным каналом») не выполнялся бы вовсе.
 *
 * Слот не привязан — сборка о паузе матча не знает, и источник один, прежний.
 */
import type { HudParams } from '../composition.js';
import type { HudPauseState, HudWorldMode } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { setText, toggleClass } from '../dom/render.js';
import { interactive } from '../host.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const MATCH_STATUS_WIDGET = 'match-status';

/** Слот действия «поставить паузу» — композиция ведёт его к команде `pause`. */
export const MATCH_STATUS_PAUSE_SLOT = 'pause';
/** Слот действия «снять паузу» — композиция ведёт его к команде `resume`. */
export const MATCH_STATUS_RESUME_SLOT = 'resume';

/**
 * Слот БИНДИНГА (не действия) с доставленным состоянием паузы матча (NTR-20).
 * Имя отличается от слота действия намеренно: реестры разные, и одно имя на
 * оба читалось бы как одно понятие. Слота нет в композиции — сборка о паузе
 * матча не знает, и источником остаётся доставленный режим мира.
 */
export const MATCH_STATUS_PAUSE_STATE_SLOT = 'pauseState';

/** Класс-модификатор паузы на корне виджета — ставится только доставкой. */
export const MATCH_STATUS_PAUSED_CLASS = 'is-paused';

/**
 * Есть ли у оболочки органы управления машиной состояний мира. Параметр записи
 * композиции, а не догадка виджета: у тонкого сетевого клиента своей перемотки
 * нет и быть не может (`netcode` NET-11, `snapshot-rewind` REW-6), и кнопка,
 * которой некуда вести, — обещание, которого сборка не выполнит. Умолчание
 * `true` сохраняет прежнее поведение локальной сборки.
 */
export const MATCH_STATUS_CONTROLS_PARAM = 'controls';

/** Строки виджета — из композиции (design, Open Questions), с умолчаниями. */
function stringParam(params: HudParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}

function boolParam(params: HudParams, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === 'boolean' ? value : fallback;
}

class MatchStatusWidget implements HudWidget {
  private readonly pauseLabel: string;
  private readonly resumeLabel: string;
  private readonly controls: boolean;

  private actions: HudActionsPort | null = null;
  private root: Element | null = null;
  private tickElement: Element | null = null;
  private modeElement: Element | null = null;
  private buttonElement: Element | null = null;
  /** Последний ДОСТАВЛЕННЫЙ режим мира — источник отображения. Клик его не меняет (HUD-2). */
  private mode: HudWorldMode = 'Running';
  /**
   * Последнее ДОСТАВЛЕННОЕ «пауза стоит» — то, по чему кнопка выбирает команду.
   * Считается в `update` из доставленного и только из него (HUD-1).
   */
  private paused = false;

  constructor(params: HudParams) {
    this.pauseLabel = stringParam(params, 'pauseLabel', 'Пауза');
    this.resumeLabel = stringParam(params, 'resumeLabel', 'Продолжить');
    this.controls = boolParam(params, MATCH_STATUS_CONTROLS_PARAM, true);
  }

  mount(actions: HudActionsPort): HudNode {
    this.actions = actions;
    return el('div', {
      classes: ['hud-match-status'],
      ref: (element) => {
        this.root = element;
      },
      children: [
        el('span', {
          classes: ['hud-match-status__tick'],
          text: '0',
          ref: (element) => {
            this.tickElement = element;
          },
        }),
        el('span', {
          classes: ['hud-match-status__mode'],
          text: this.mode,
          ref: (element) => {
            this.modeElement = element;
          },
        }),
        // Интерактивна только кнопка: контейнер указатель не перехватывает (HUD-3).
        // Оболочки без управления машиной состояний кнопки не получают вовсе —
        // не спрятанную стилем, а не построенную: показанная и неработающая
        // кнопка врала бы о том, что матч можно остановить.
        ...(this.controls
          ? [
              interactive(
                el('button', {
                  classes: ['hud-match-status__pause'],
                  attrs: { type: 'button' },
                  text: this.pauseLabel,
                  on: {
                    click: () => {
                      this.togglePause();
                    },
                  },
                  ref: (element) => {
                    this.buttonElement = element;
                  },
                }),
              ),
            ]
          : []),
      ],
    });
  }

  /**
   * Кнопка шлёт команду по последней ДОСТАВЛЕННОЙ паузе и НЕ трогает DOM:
   * «пауза» на экране появится, когда её доставит оболочка (HUD-2, сценарий
   * «Пауза из HUD»). Локальная реакция элемента (`:active` кнопки) — дело CSS.
   */
  private togglePause(): void {
    this.actions?.trigger(this.paused ? MATCH_STATUS_RESUME_SLOT : MATCH_STATUS_PAUSE_SLOT);
  }

  /**
   * Точечные обновления только по изменению — `setText`/`toggleClass` сами не
   * пишут без надобности. `update.snap` виджету нечего снапать: накопленных
   * анимаций нет, каждая запись и так прыгает к доставленному значению (HUD-5).
   *
   * Строка режима остаётся режимом МИРА последнего снапшота: она о нём и
   * говорит. Заморозка матча — отдельный доставленный факт (NTR-20), и её
   * показывают класс паузы и надпись кнопки, а не подмена этой строки.
   */
  update(update: HudUpdate): void {
    this.mode = update.mode;
    this.paused = this.pausedBy(update);
    if (this.tickElement !== null) setText(this.tickElement, String(update.tick));
    if (this.modeElement !== null) setText(this.modeElement, update.mode);
    if (this.root !== null) toggleClass(this.root, MATCH_STATUS_PAUSED_CLASS, this.paused);
    if (this.buttonElement !== null) {
      setText(this.buttonElement, this.paused ? this.resumeLabel : this.pauseLabel);
    }
  }

  /**
   * «Пауза стоит» по доставленному. Состояние паузы матча приезжает своим
   * каденсом и потому бьёт режим мира: в заморозке снапшотов нет вовсе, и
   * `update.mode` всё это время описывает мир ДО паузы (NTR-20).
   *
   * Значения в слоте нет — либо сборка его не привязала (локальный прогон),
   * либо состояния паузы ещё не доставляли: и там и там ответ даёт режим мира,
   * а выдумывать паузу из молчания нельзя (HUD-9).
   */
  private pausedBy(update: HudUpdate): boolean {
    const delivered = update.values[MATCH_STATUS_PAUSE_STATE_SLOT] as HudPauseState | undefined;
    if (delivered === undefined) return update.mode === 'Paused';
    return delivered.state !== 'running';
  }

  dispose(): void {
    this.actions = null;
    this.root = null;
    this.tickElement = null;
    this.modeElement = null;
    this.buttonElement = null;
  }
}

/** Вид виджета статуса матча — регистрируется в реестре видов (HUD-4). */
export const matchStatusKind: HudWidgetKind = {
  name: MATCH_STATUS_WIDGET,
  create: (params) => new MatchStatusWidget(params),
};
