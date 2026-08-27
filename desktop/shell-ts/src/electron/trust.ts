/**
 * Клей вопроса доверия (DSK-8, решение D2): системное окно и каталог данных.
 *
 * Здесь нет ни одного решения и ни одной проверяемой ветви. Порядок оснований,
 * книга доверия, схлопывание вопросов, текст вопроса, гейт прогонного автоответа
 * и ответ за открытые вопросы при закрытии окна живут в `src/host/trust.ts` на
 * чистом Node и проверены в гейте (DSK-6). Клею остаётся ровно то, чего на
 * чистом Node не бывает: `dialog.showMessageBox` и `app.getPath`.
 */
import { app, dialog, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createTrustAsk, trustBookPath, type TrustDialog, type TrustQuestion } from '../host/index.js';

/**
 * Где лежит книга доверия: каталог данных контейнера, рядом с состоянием
 * сервисов (решение D1). Временный каталог для неё не годится по той же причине,
 * что и для адресного файла сервиса: «переживает сессию» обязано пережить и
 * уборку /tmp. Подмену пути разрешает или запрещает хост-слой (`trustBookPath`).
 */
export function trustBookFrom(argv: readonly string[]): string {
  return trustBookPath(argv, join(app.getPath('userData'), 'trust.json'));
}

export interface TrustDialogOptions {
  /** Окно сессии: его может уже не быть, поэтому спрашивается каждый раз. */
  readonly window: () => BrowserWindow | null;
  readonly argv: readonly string[];
  /** Куда складывать вопросы под прогонным автоответом (их читает сьют). */
  readonly asked: TrustQuestion[];
}

/**
 * Вопрос ЧЕЛОВЕКУ — второе основание доверия (DSK-8).
 *
 * Текст собирает хост-слой (`trustPrompt`): «предъявить с origin соединения и
 * отпечатком SHA-256», а при смене — «с прежним и новым отпечатками» — это
 * требование, и проверяется оно в гейте. Клею остаётся окно и две кнопки.
 */
export function createTrustDialog(options: TrustDialogOptions): TrustDialog {
  return createTrustAsk({
    argv: options.argv,
    asked: options.asked,
    show: (prompt) => {
      const target = options.window();
      // Окна нет — спрашивать некого, и «некого спросить» означает отказ.
      if (target === null) return Promise.resolve(false);
      return dialog
        .showMessageBox(target, {
          type: prompt.changed ? 'warning' : 'question',
          title: prompt.title,
          message: prompt.message,
          detail: prompt.detail,
          buttons: ['Доверять', 'Отклонить'],
          // Отказ — и умолчание, и ответ на закрытие диалога: соглашаться
          // нечаянно человек не должен, а закрытие диалога DSK-8 приравнивает
          // к отказу.
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        })
        .then((result) => result.response === 0);
    },
  });
}
