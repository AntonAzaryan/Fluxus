/**
 * Латч ввода воркер-стороны и разбор сообщений главного потока (SHELL-3,
 * SHELL-6) — общее обоих режимов оболочки (SHELL-8).
 *
 * Сырые сообщения main латчатся: `move` — состояние, и остаётся до следующего
 * сообщения; `buttons` — фронты, и копятся OR-ом, чтобы нажатие между двумя
 * съёмами не потерялось; `aimDir` запоминается только вместе с непустыми
 * кнопками — курс прицела без нажатия ничего не значит. Съём (`take`) очищает
 * кнопки и не трогает `move`.
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
import type { Vec2 } from '@game-mvp/core';
import type { ShellSender } from './sender.js';
import type { ControlMessage, InputMessage, MainToWorker } from './protocol.js';

/** Снятый латч: ровно то, из чего собирается кадр ввода любого режима. */
export interface InputLatchSample {
  readonly move: Vec2;
  readonly aimDir: number;
  readonly buttons: number;
}

export class InputLatch {
  private move: Vec2 = { x: 0, y: 0 };
  private aimDir = 0;
  private buttons = 0;

  /** Сырое сообщение ввода главного потока (SHELL-6). */
  apply(message: InputMessage): void {
    this.move = message.move;
    this.buttons |= message.buttons;
    if (message.buttons !== 0) this.aimDir = message.aimDir;
  }

  /**
   * Нажатие, синтезированное самой оболочкой: так сетевой режим отправляет
   * запрос машины состояний вводом на сервер (SHELL-6, NET-11).
   */
  press(mask: number): void {
    this.buttons |= mask;
  }

  /** Съём латча: кнопки — фронты, латч очищается; move — состояние, остаётся. */
  take(): InputLatchSample {
    const sample: InputLatchSample = {
      move: this.move,
      aimDir: this.aimDir,
      buttons: this.buttons,
    };
    this.buttons = 0;
    return sample;
  }
}

/**
 * Разбор сообщения main → worker (SHELL-3, SHELL-6): возврат буфера — ack
 * каналу, ввод — в латч, запрос перехода — обработчику режима.
 */
export function routeMainMessage(
  message: MainToWorker,
  sender: ShellSender,
  input: InputLatch,
  onControl: (message: ControlMessage) => void,
): void {
  switch (message.t) {
    case 'ret':
      sender.ack(message.buffer);
      return;
    case 'input':
      input.apply(message);
      return;
    case 'control':
      onControl(message);
      return;
  }
}
