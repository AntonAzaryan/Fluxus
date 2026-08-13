/**
 * Рантайм-панель (HUD-4): кадры в секунду, номер доставленного тика и число
 * доставленных сущностей.
 *
 * Две величины разной природы, и это здесь главное. Тик и число сущностей —
 * ДОСТАВЛЕННОЕ состояние (HUD-1): они приходят каденсом доставки. Счётчик
 * кадров — величина САМОГО главного потока: он меряется по окну кадров
 * (`HudWidget.frame`, SHELL-7) и через границу потоков не едет вовсе — это не
 * данные мира, и в плоской форме им места нет.
 */
import type { HudParams } from '../composition.js';
import type { HudEntityView } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { setText } from '../dom/render.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';

/** Имя вида в реестре — то, на что ссылается запись композиции. */
export const RUNTIME_WIDGET = 'runtime';
/** Слот биндинга: все доставленные сущности — их и считает панель. */
export const RUNTIME_ENTITIES_SLOT = 'entities';

/** Окно усреднения счётчика кадров: полсекунды — число не дрожит и не врёт. */
const DEFAULT_WINDOW_MS = 500;

function numberParam(params: HudParams, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Счётчик кадров по скользящему окну: кадры и время копятся, по заполнении
 * окна частота пересчитывается. Ни таймеров, ни `requestAnimationFrame` внутри
 * — кадр приносит вызывающий (`HudWidget.frame`), поэтому счётчик тестируется
 * без браузера.
 */
export class FrameRateMeter {
  private frames = 0;
  private elapsedMs = 0;
  private value = 0;

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  /** Кадр длиной `dt` секунд; возвращает true, если частота пересчиталась. */
  push(dt: number): boolean {
    this.frames += 1;
    this.elapsedMs += dt * 1000;
    if (this.elapsedMs < this.windowMs) return false;
    this.value = this.elapsedMs > 0 ? (this.frames * 1000) / this.elapsedMs : 0;
    this.frames = 0;
    this.elapsedMs = 0;
    return true;
  }

  /** Последняя измеренная частота; 0 — окно ещё не закрылось ни разу. */
  get fps(): number {
    return this.value;
  }
}

class RuntimeWidget implements HudWidget {
  private readonly meter: FrameRateMeter;

  private fpsElement: Element | null = null;
  private tickElement: Element | null = null;
  private entitiesElement: Element | null = null;

  constructor(params: HudParams) {
    this.meter = new FrameRateMeter(numberParam(params, 'windowMs', DEFAULT_WINDOW_MS));
  }

  mount(_actions: HudActionsPort): HudNode {
    return el('div', {
      classes: ['hud-runtime'],
      children: [
        el('span', {
          classes: ['hud-runtime__fps'],
          text: '0',
          ref: (element) => {
            this.fpsElement = element;
          },
        }),
        el('span', {
          classes: ['hud-runtime__tick'],
          text: '0',
          ref: (element) => {
            this.tickElement = element;
          },
        }),
        el('span', {
          classes: ['hud-runtime__entities'],
          text: '0',
          ref: (element) => {
            this.entitiesElement = element;
          },
        }),
      ],
    });
  }

  update(update: HudUpdate): void {
    const entities = update.values[RUNTIME_ENTITIES_SLOT] as
      | ReadonlyMap<number, HudEntityView>
      | undefined;
    if (this.tickElement !== null) setText(this.tickElement, String(update.tick));
    if (this.entitiesElement !== null) setText(this.entitiesElement, String(entities?.size ?? 0));
  }

  /** Кадр главного потока: доставленного состояния в нём нет и не нужно. */
  frame(dt: number): void {
    if (!this.meter.push(dt) || this.fpsElement === null) return;
    setText(this.fpsElement, String(Math.round(this.meter.fps)));
  }

  dispose(): void {
    this.fpsElement = null;
    this.tickElement = null;
    this.entitiesElement = null;
  }
}

/** Вид рантайм-панели — регистрируется в реестре видов (HUD-4). */
export const runtimeKind: HudWidgetKind = {
  name: RUNTIME_WIDGET,
  create: (params) => new RuntimeWidget(params),
};
