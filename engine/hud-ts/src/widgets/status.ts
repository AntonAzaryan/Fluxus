/**
 * Виджет статуса матча (задача 5.1): тик, режим мира и признак паузы — из
 * доставленного состояния, кнопка паузы/продолжения — действием обратного
 * канала (HUD-2, сценарий «Пауза из HUD»).
 *
 * Тик и режим виджет читает из конверта обновления (`HudUpdate.tick`/`.mode`):
 * исполнитель заполняет их из того же доставленного состояния, что и значения
 * селекторов (`runtime.ts`), — отдельный биндинг был бы вторым именем того же
 * поля. Видимое состояние «пауза» — ТОЛЬКО производная доставленного `mode`:
 * клик по кнопке шлёт команду и не трогает отображение — исход мирового
 * действия HUD наблюдает в доставленном состоянии, а не изображает сам (HUD-2).
 */
import type { HudParams } from '../composition.js';
import type { HudWorldMode } from '../delivery.js';
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

/** Класс-модификатор паузы на корне виджета — ставится только доставкой. */
export const MATCH_STATUS_PAUSED_CLASS = 'is-paused';

/** Строки виджета — из композиции (design, Open Questions), с умолчаниями. */
function stringParam(params: HudParams, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
}

class MatchStatusWidget implements HudWidget {
  private readonly pauseLabel: string;
  private readonly resumeLabel: string;

  private actions: HudActionsPort | null = null;
  private root: Element | null = null;
  private tickElement: Element | null = null;
  private modeElement: Element | null = null;
  private buttonElement: Element | null = null;
  /**
   * Последний ДОСТАВЛЕННЫЙ режим — единственный источник и для отображения,
   * и для выбора команды кнопки. Клик его не меняет (HUD-2).
   */
  private mode: HudWorldMode = 'Running';

  constructor(params: HudParams) {
    this.pauseLabel = stringParam(params, 'pauseLabel', 'Пауза');
    this.resumeLabel = stringParam(params, 'resumeLabel', 'Продолжить');
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
      ],
    });
  }

  /**
   * Кнопка шлёт команду по последнему доставленному режиму и НЕ трогает DOM:
   * «пауза» на экране появится, когда её доставит оболочка (HUD-2, сценарий
   * «Пауза из HUD»). Локальная реакция элемента (`:active` кнопки) — дело CSS.
   */
  private togglePause(): void {
    this.actions?.trigger(
      this.mode === 'Paused' ? MATCH_STATUS_RESUME_SLOT : MATCH_STATUS_PAUSE_SLOT,
    );
  }

  /**
   * Точечные обновления только по изменению — `setText`/`toggleClass` сами не
   * пишут без надобности. `update.snap` виджету нечего снапать: накопленных
   * анимаций нет, каждая запись и так прыгает к доставленному значению (HUD-5).
   */
  update(update: HudUpdate): void {
    this.mode = update.mode;
    const paused = update.mode === 'Paused';
    if (this.tickElement !== null) setText(this.tickElement, String(update.tick));
    if (this.modeElement !== null) setText(this.modeElement, update.mode);
    if (this.root !== null) toggleClass(this.root, MATCH_STATUS_PAUSED_CLASS, paused);
    if (this.buttonElement !== null) {
      setText(this.buttonElement, paused ? this.resumeLabel : this.pauseLabel);
    }
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
