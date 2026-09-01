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
 * Форм у мирового действия-ввода две, и обе — формы ОРГАНА управления, а не
 * два механизма (HUD-2): фронт (`dispatch`) латчит нажатие до ближайшей
 * границы тика, удержание (`hold`/`release`) держит действие в множестве
 * `held()` — том самом, которое сэмплер ORит в маску кадра все тики подряд
 * (INP-2). Обе половины делает и клавиатура: `keydown` латчит фронт И кладёт
 * код в удержания, поэтому взятие кнопки HUD делает то же самое — иначе
 * нажатие кнопки короче тика отличалось бы от такого же нажатия клавиши.
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
  /**
   * Удерживаемое: имена СЕМАНТИЧЕСКИХ действий (INP-4), а не имена записей
   * реестра, — сэмплер переводит их в биты тем же словарём биндингов, что у
   * клавиатуры. Множество переиспользуется: `held()` зовётся каждую выборку, и
   * свежий объект на выборку был бы мусором ровно там, где его быть не должно.
   */
  private readonly heldActions = new Set<string>();

  constructor(options: HudActionsFacadeOptions) {
    this.options = options;
  }

  start(press: ActionSink): void {
    this.press = press;
  }

  /**
   * Снятие с сэмплера гасит и удержания — по той же причине, по которой их
   * гасит потеря фокуса окна у клавиатуры: бит, оставшийся в множестве после
   * отключения источника, был бы вводом, которого игрок не давал (INP-5).
   */
  stop(): void {
    this.press = null;
    this.heldActions.clear();
  }

  /** Непрерывных осей у HUD нет: источник фронтов и удержаний (INP-5). */
  poll(): ContinuousSample | null {
    return null;
  }

  /**
   * Удерживаемые действия на момент выборки (INP-2). Сэмплер ORит их в маску
   * кадра поверх залатченных фронтов, поэтому удержание кнопки HUD видно
   * симуляции все тики подряд, а отпускание — как falling edge: ровно то же,
   * что даёт удержание назначенной клавиши (HUD-2).
   */
  held(): ReadonlySet<string> {
    return this.heldActions;
  }

  /**
   * Взятие органа управления формы «удержание» (HUD-2): фронт латчится, и
   * действие встаёт в множество удержаний до `release`.
   *
   * Только мировое действие-ввод: у команды машины состояний удержания нет
   * (это единичный запрос перехода), у presentation-действия — тем более.
   * Попытка — ошибка сборки, названная по имени действия, а не тихий no-op:
   * молчание выглядело бы как работающая кнопка, которая ничего не делает.
   */
  hold(name: string): void {
    const decl = this.worldDecl(name, 'удержание');
    if (this.press === null) {
      throw new Error(
        `действие "${name}": фасад не добавлен в сэмплер ввода — мировому действию не через что уйти (SHELL-6)`,
      );
    }
    // Фронт — тоже: клавиатура на `keydown` делает и латч, и удержание, и
    // кнопка обязана делать то же (HUD-2).
    this.press(decl.action);
    this.heldActions.add(decl.action);
  }

  /** Отпускание органа управления формы «удержание» (HUD-2, INP-5). */
  release(name: string): void {
    this.heldActions.delete(this.worldDecl(name, 'отпускание').action);
  }

  /** Объявление мирового действия-ввода или названная ошибка формы. */
  private worldDecl(name: string, form: string): { readonly action: string } {
    const decl = this.options.actions.action(name);
    if (decl.target !== 'world') {
      throw new Error(
        `действие "${name}": ${form} есть форма мирового действия-ввода (HUD-2), а объявлено оно как "${decl.target}"`,
      );
    }
    return decl;
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
