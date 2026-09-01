/**
 * Форма запуска сервера (`server-manager` MGR-2): имена её полей и перевод
 * введённого в параметры запуска (`server-control` SRV-2).
 *
 * Отдельным модулем, а не парой строк в слое монтирования, по той же причине, по
 * которой отдельно живёт описание представления: MGR-2 требует «запустить сервер
 * С ПАРАМЕТРАМИ ЗАПУСКА (SRV-2)», а SRV-2 перечисляет их поимённо — документ
 * матча, порт, профиль бота, дедлайн бот-заполнителя, политика разрыва,
 * авто-рестарт. Утверждение «форма отдаёт все шесть, и отдаёт их правильно»
 * обязан держать тест, а не глаз на `app/main.ts`, куда тест не дотягивается.
 *
 * Умолчания здесь — умолчания СТЕНДА, а не свои: пустое поле означает «стенд
 * решает сам» (пустая строка, `null`), а не подставленный менеджером ноль.
 */
import type { StartParams } from '@fluxus/server-agent/protocol';

/** Имена полей формы; они же — имена действий узлов представления. */
export const LAUNCH_FIELDS = {
  host: 'launch-host',
  match: 'launch-match',
  port: 'launch-port',
  bot: 'launch-bot',
  botFill: 'launch-bot-fill',
  onDisconnect: 'launch-on-disconnect',
  autoRestart: 'launch-auto-restart',
} as const;

/**
 * Политика разрыва (BOT-14, NTR-20) — закрытый перечень стенда; пустая строка
 * означает умолчание документа матча. Свободной строкой это поле быть не может:
 * незнакомое слово стенд отверг бы уже после запуска.
 */
export const ON_DISCONNECT_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'разрыв: умолчание матча' },
  { value: 'bot', label: 'разрыв: бот-заместитель' },
  { value: 'hold', label: 'разрыв: держать слот' },
  { value: 'pause', label: 'разрыв: пауза матча' },
];

/** Значения переключателя авто-рестарта: пустого умолчания у него нет. */
export const AUTO_RESTART_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'yes', label: 'авто-рестарт: да' },
  { value: 'no', label: 'авто-рестарт: нет' },
];

/**
 * Поля формы → параметры запуска (SRV-2). `defaultMatch` — документ, который
 * форма ПОКАЗЫВАЕТ по умолчанию (первый в перечне целевого хоста): показанное и
 * отправляемое обязаны совпадать, иначе запуск уходит не с тем, что видел
 * человек (MGR-2).
 */
export function startParamsOf(
  fields: ReadonlyMap<string, string>,
  defaultMatch: string,
): StartParams {
  const value = (name: string): string => (fields.get(name) ?? '').trim();
  const match = value(LAUNCH_FIELDS.match);
  const port = Number(value(LAUNCH_FIELDS.port));
  const botFill = value(LAUNCH_FIELDS.botFill);
  const botFillMs = Number(botFill);
  return {
    match: match === '' ? defaultMatch : match,
    // Порт «авто» (`0`) — умолчание агента: свободный он выберет сам (SRV-2).
    // Нечисло тоже уходит нулём, и это не подмена смысла: у порта «пусто» и
    // «авто» — одно и то же намерение.
    port: Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : 0,
    bot: value(LAUNCH_FIELDS.bot),
    // Дедлайн бот-заполнителя (BOT-7): пусто — умолчание стенда, а не ноль,
    // который означал бы «заполнить ботами немедленно».
    botFillMs: botFill !== '' && Number.isFinite(botFillMs) && botFillMs >= 0 ? Math.trunc(botFillMs) : null,
    onDisconnect: value(LAUNCH_FIELDS.onDisconnect),
    // Умолчание — «поднимать заново»: оно же умолчание стенда, и `--once` он
    // получает ровно тогда, когда человек выбрал «нет» (SRV-2).
    autoRestart: value(LAUNCH_FIELDS.autoRestart) !== 'no',
  };
}
