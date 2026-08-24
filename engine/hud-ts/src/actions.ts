/**
 * Фасад действий HUD с двумя адресатами (HUD-2, design Decision 4). Адресат —
 * часть объявления действия, а не решение виджета: виджет дёргает имя, куда
 * оно ведёт — знает реестр.
 *
 * Мировые действия уходят обратным каналом оболочки и только им (SHELL-6):
 * фасад — обычный `InputSource` слоя ввода, и нажатие кнопки HUD пушит то же
 * семантическое имя действия в тот же латч `InputSampler`, что нажатие
 * назначенной клавиши в `KeyboardMouseSource` (INP-2, INP-4). «Кнопка
 * неотличима от клавиши» выполняется конструктивно: в воркер уходит один и
 * тот же канонический ввод, и симуляция не различает источники. Команды
 * машины состояний мира (пауза, перемотка) — второй мировой путь того же
 * канала: `RemoteHost.control` (SHELL-6, WSM-1..6).
 *
 * Presentation-действия исполняются локально в главном потоке через узкий
 * контракт камеры и сообщений воркеру не порождают: симуляция о них не
 * узнаёт (HUD-2).
 */
import type { ActionSink, ContinuousSample, ControlMessage, InputSource } from '@fluxus/client';

/**
 * Контракт управления камерой для presentation-действий (HUD-2): узкая
 * поверхность, которую сборка клиента реализует поверх своего `CameraRig`.
 * Проекционный шов «мир → экран» сюда сознательно не входит (design,
 * «Отложенные швы»): у него нет потребителя в первой версии.
 */
export interface HudCameraContract {
  /** Перевести камеру в точку арены (клик миникарты). */
  panTo(x: number, y: number): void;
  /** Фокус на герое (кнопка «к герою»). */
  focusOnHero(): void;
}

/** Числовая нагрузка действия: точка клика миникарты, тик перемотки. */
export type HudActionPayload = Readonly<Record<string, number>>;

/**
 * Объявление именованного действия. Мировые варианты несут имя семантического
 * действия из словаря биндингов (INP-4) либо команду машины состояний;
 * presentation-вариант — вызов контракта камеры. Замыкание здесь легально:
 * объявление живёт в реестре (код), композиция ссылается на него именем и
 * остаётся JSON-значением (HUD-4).
 */
export type HudActionDecl =
  | {
      readonly target: 'world';
      /** Имя семантического действия — то же, что у клавиатурного биндинга (INP-4). */
      readonly action: string;
    }
  | {
      readonly target: 'control';
      /** Команда машины состояний мира (WSM-1..6); `tick` берётся из нагрузки. */
      readonly action: ControlMessage['action'];
    }
  | {
      readonly target: 'presentation';
      readonly run: (camera: HudCameraContract, payload?: HudActionPayload) => void;
    };

/** Обратный канал команд — структурный минимум `RemoteHost` (SHELL-6). */
export interface HudControlChannel {
  control(action: ControlMessage['action'], tick?: number): void;
}

/** Источник объявлений по имени; реализует `HudRegistry`. */
export interface HudActionSource {
  action(name: string): HudActionDecl;
}

export interface HudActionsFacadeOptions {
  readonly actions: HudActionSource;
  readonly camera: HudCameraContract;
  /** Нужен только действиям `control`; сборка без них канал не передаёт. */
  readonly control?: HudControlChannel;
}

export class HudActionsFacade implements InputSource {
  /** Имя источника в сэмплере ввода (INP-1). */
  readonly id = 'hud';

  private readonly options: HudActionsFacadeOptions;
  /** Латч фронтов сэмплера; null — фасад не добавлен в сэмплер (INP-2). */
  private press: ActionSink | null = null;

  constructor(options: HudActionsFacadeOptions) {
    this.options = options;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  stop(): void {
    this.press = null;
  }

  /** Непрерывных осей у HUD нет: источник фронтов, а не движения (INP-5). */
  poll(): ContinuousSample | null {
    return null;
  }

  /**
   * Единственная точка исполнения действий HUD: имя → объявление реестра →
   * адресат. Виджет не знает, мировое действие или presentation (HUD-2).
   */
  dispatch(name: string, payload?: HudActionPayload): void {
    const decl = this.options.actions.action(name);
    switch (decl.target) {
      case 'world': {
        if (this.press === null) {
          throw new Error(
            `действие "${name}": фасад не добавлен в сэмплер ввода — мировому действию не через что уйти (SHELL-6)`,
          );
        }
        this.press(decl.action);
        return;
      }
      case 'control': {
        const control = this.options.control;
        if (control === undefined) {
          throw new Error(`действие "${name}": обратный канал команд не передан фасаду (SHELL-6)`);
        }
        // seekTo без цели — ошибка конфигурации, а не команда: канал молча
        // передал бы `undefined`, и воркер так же молча её проигнорировал бы.
        if (decl.action === 'seekTo' && typeof payload?.tick !== 'number') {
          throw new Error(
            `действие "${name}": команде seekTo нужен числовой "tick" в нагрузке (WSM-5)`,
          );
        }
        control.control(decl.action, payload?.tick);
        return;
      }
      case 'presentation':
        decl.run(this.options.camera, payload);
    }
  }
}
