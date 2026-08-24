/**
 * Латч ввода воркер-стороны и разбор сообщений главного потока (SHELL-3,
 * SHELL-6) — общее обоих режимов оболочки (SHELL-8).
 *
 * Сырые сообщения main латчатся: `move` — состояние, и остаётся до следующего
 * сообщения; `buttons` — фронты, и копятся OR-ом, чтобы нажатие между двумя
 * съёмами не потерялось; `aimDir` запоминается только вместе с непустыми
 * кнопками — курс прицела без нажатия ничего не значит; `target` — состояние
 * наравне с `move`. Съём (`take`) очищает кнопки и не трогает ни `move`, ни
 * точку.
 *
 * Латч один на оба режима не по экономии строк, а потому что правило одно:
 * локальная сторона собирает из него `InputFrame` на границе тика, сетевая —
 * `InputSample` на отправку серверу, и разойтись эти два съёма не имеют права —
 * иначе «нажатие между тиками не теряется» значило бы в режимах разное.
 *
 * Что режимам НЕ общее и потому сюда не переезжает — обработка запроса машины
 * состояний (`control`): локальный режим исполняет переход у себя через core-API
 * (WSM-5), сетевой отправляет его вводом на сервер и у себя исполнять MUST NOT
 * (`netcode` NET-11). Разбор сообщений поэтому и берёт обработчик параметром.
 */
import type { Vec2 } from '@fluxus/core';
import type { ShellSender } from './sender.js';
import type { ControlMessage, InputMessage, MainToWorker } from './protocol.js';

/** Снятый латч: ровно то, из чего собирается кадр ввода любого режима. */
export interface InputLatchSample {
  readonly move: Vec2;
  readonly aimDir: number;
  /** Точка прицела (TICK-2); `undefined` — её не давали ни разу. */
  readonly target?: Vec2;
  readonly buttons: number;
}

export class InputLatch {
  private move: Vec2 = { x: 0, y: 0 };
  private aimDir = 0;
  private target: Vec2 | undefined;
  private buttons = 0;

  /** Сырое сообщение ввода главного потока (SHELL-6). */
  apply(message: InputMessage): void {
    this.move = message.move;
    this.buttons |= message.buttons;
    if (message.buttons !== 0) this.aimDir = message.aimDir;
    // Точка латчится как СОСТОЯНИЕ и без гейта по кнопкам — в отличие от
    // `aimDir`. Гейт там стоит потому, что курс прицела без нажатия ничего не
    // значит; у точки это не так: цепочка прицеливания (ABIL-5) читает её
    // каждый тик каста, а подтверждает шаг отдельным битом, и точка, доехавшая
    // только в тик нажатия, означала бы прицеливание вслепую между шагами.
    if (message.target !== undefined) this.target = message.target;
  }

  /**
   * Нажатие, синтезированное самой оболочкой: так сетевой режим отправляет
   * запрос машины состояний вводом на сервер (SHELL-6, NET-11).
   */
  press(mask: number): void {
    this.buttons |= mask;
  }

  /**
   * Сброс накопленных фронтов БЕЗ съёма кадра: так замороженный мир гасит ввод,
   * которому применяться некуда (REW-5). Иначе нажатия, сделанные за время
   * заморозки, доехали бы залпом до первого живого тика после возобновления.
   */
  dropButtons(): void {
    this.buttons = 0;
  }

  /** Съём латча: кнопки — фронты, латч очищается; move — состояние, остаётся. */
  take(): InputLatchSample {
    const sample: InputLatchSample = {
      move: this.move,
      aimDir: this.aimDir,
      // Точка — состояние, и съём её не гасит: тот же класс, что `move`.
      ...(this.target === undefined ? {} : { target: this.target }),
      buttons: this.buttons,
    };
    this.buttons = 0;
    return sample;
  }
}

/**
 * Разбор сообщения main → worker (SHELL-3, SHELL-6): возврат буфера — ack
 * каналу, ввод — в латч, запрос перехода — обработчику режима.
 *
 * `onInput` — необязательный наблюдатель СЫРОГО сообщения ввода, уже положенного
 * в латч: латч отвечает на «нажимали ли между тиками», и режиму, которому нужно
 * «держат ли орган управления сейчас» (ведение точки перемотки в локальном
 * режиме, REW-5), приходится читать входящее сообщение напрямую. Разбирать вид
 * сообщения второй раз ради этого режимы не должны — вид сообщений знает роутер.
 */
export function routeMainMessage(
  message: MainToWorker,
  sender: ShellSender,
  input: InputLatch,
  onControl: (message: ControlMessage) => void,
  onInput?: (message: InputMessage) => void,
): void {
  switch (message.t) {
    case 'ret':
      sender.ack(message.buffer);
      return;
    case 'input':
      input.apply(message);
      onInput?.(message);
      return;
    case 'control':
      onControl(message);
      return;
  }
}
