/**
 * Политики стенда демо-арены (`bin/demo-serve.mjs`), выраженные значениями:
 * сколько ждать людей до старта, что делать со слотом, оставшимся без
 * соединения, через сколько сажать заместителя и каким считать окно возврата.
 *
 * Всё это — политика СБОРКИ-ОСНОВАТЕЛЯ, а не сервера матча: сервер даёт
 * механизм аренды слота (`netcode-transport` NTR-17, NTR-18) и о том, кто и
 * когда садится в опустевший слот, не знает (`bot-player` BOT-1, BOT-14).
 *
 * Отдельным модулем от самого стенда — по той же причине, по которой из него
 * выделена слушающая сторона (`standSession.ts`): умолчание, которое молча
 * уехало, снаружи выглядит как «стенд ведёт себя странно», и проверять его
 * нужно тестом, а не чтением команды. Своего разбора аргументов здесь нет —
 * читатели приезжают снаружи, и парсер флагов остаётся один на все запускалки
 * (CLI-11).
 */

/**
 * Что стенд делает со слотом, потерявшим соединение (BOT-14):
 *
 * - `bot` — сажает бота-заместителя (`netcode-transport` NTR-18);
 * - `hold` — не делает ничего: слот живёт на predicted-кадрах и ждёт владельца,
 *   а по превышению порога молчания матч завершается (NTR-6).
 */
export type DisconnectPolicy = 'bot' | 'hold';

export const DISCONNECT_POLICIES: readonly DisconnectPolicy[] = ['bot', 'hold'];

/**
 * Умолчания стенда. Числа здесь — политика демо, и меняются они здесь либо
 * флагом запуска, а не в коде сервера матча.
 */
export const STAND_DEFAULTS = {
  /**
   * Дедлайн бота-заполнителя (BOT-7) после ПЕРВОГО претендента на слот: две
   * минуты. Прежних пяти секунд не хватало второму игроку открыть ссылку
   * `npm run demo:lan`, и матч начинался с ботом раньше, чем человек успевал
   * дойти до вкладки. Одиночная игра, которой бот нужен сразу, задаёт меньший
   * дедлайн флагом; отладочный прогон (CLI-11) сажает ботов немедленно.
   */
  botFillMs: 120_000,
  /**
   * Пауза между разрывом и посадкой заместителя. Не ноль: разрыв на секунду и
   * уход игрока в момент разрыва неотличимы (NTR-6), и дёргать бота на каждый
   * сетевой всплеск незачем.
   */
  substituteDelayMs: 2000,
  /** Что делать со слотом без соединения, если запуск не сказал иного. */
  onDisconnect: 'bot' as DisconnectPolicy,
} as const;

/** Отладочный прогон: боты садятся немедленно — человека за клавиатурой нет (CLI-11). */
export const DEBUG_BOT_FILL_MS = 0;

export interface StandPolicyInput {
  /** Значение строкового флага в обеих формах (`--name=v` и `--name v`). */
  readonly text: (name: string, fallback: string) => string;
  /** Значение числового флага; отказ на нечисловом — забота читателя. */
  readonly number: (name: string, fallback: number) => number;
  /** Отладочный прогон (`--debug`): у него свои умолчания. */
  readonly debug: boolean;
  /**
   * Порог молчания ДОКУМЕНТА матча в секундах (`silenceSeconds`) — умолчание
   * для флага: величина остаётся данными, а флаг лишь перекрывает её для одного
   * запуска (design D7).
   */
  readonly silenceSeconds: number;
}

export interface StandPolicy {
  /** Дедлайн бота-заполнителя в миллисекундах (BOT-7). */
  readonly botFillMs: number;
  readonly onDisconnect: DisconnectPolicy;
  readonly substituteDelayMs: number;
  /** Окно возврата в секундах: порог молчания слота (NTR-6, NTR-17). */
  readonly silenceSeconds: number;
}

/**
 * Политики одного запуска стенда. Неизвестное значение `--on-disconnect` —
 * ОТКАЗ, а не тихое умолчание: «--on-disconnect none» иначе означал бы «сажать
 * бота», то есть прямо противоположное написанному в команде.
 */
export function standPolicy(input: StandPolicyInput): StandPolicy {
  const onDisconnect = input.text('on-disconnect', STAND_DEFAULTS.onDisconnect);
  if (!DISCONNECT_POLICIES.includes(onDisconnect as DisconnectPolicy)) {
    throw new Error(
      `--on-disconnect: неизвестная политика "${onDisconnect}"; известные: ${DISCONNECT_POLICIES.join(', ')}`,
    );
  }
  return {
    botFillMs: input.number(
      'bot-fill-ms',
      input.debug ? DEBUG_BOT_FILL_MS : STAND_DEFAULTS.botFillMs,
    ),
    onDisconnect: onDisconnect as DisconnectPolicy,
    substituteDelayMs: input.number('substitute-delay-ms', STAND_DEFAULTS.substituteDelayMs),
    silenceSeconds: input.number('silence-seconds', input.silenceSeconds),
  };
}
