/**
 * Политики стенда демо-арены (`app/standPolicy.ts`): умолчания и перекрытие их
 * флагами запуска.
 *
 * Проверяется здесь то, что снаружи выглядит не как дефект, а как «стенд ведёт
 * себя странно»: уехавшее умолчание. Два игрока не успевают собраться, если
 * дедлайн бота-заполнителя снова стал пятью секундами (D10); окно возврата в
 * десять секунд вместо пяти минут превращает любой сетевой всплеск в конец
 * матча (NTR-6, NTR-17); молча проглоченное `--on-disconnect none` означало бы
 * ровно противоположное написанному в команде (BOT-14).
 */
import { describe, expect, it } from 'vitest';
import {
  standPolicy,
  DEBUG_BOT_FILL_MS,
  STAND_DEFAULTS,
  type StandPolicyInput,
} from '../app/standPolicy.js';

/** Читатели флагов: те же две формы значения, что у запускалок, тесту не нужны. */
function readers(flags: Readonly<Record<string, string>> = {}): Pick<
  StandPolicyInput,
  'text' | 'number'
> {
  return {
    text: (name, fallback) => flags[name] ?? fallback,
    number: (name, fallback) => (flags[name] === undefined ? fallback : Number(flags[name])),
  };
}

/** Документ демо-арены называет окно возврата сам — умолчание флага берётся оттуда. */
const DOCUMENT_SILENCE_SECONDS = 300;

function policy(flags: Readonly<Record<string, string>> = {}, debug = false) {
  return standPolicy({
    ...readers(flags),
    debug,
    silenceSeconds: DOCUMENT_SILENCE_SECONDS,
  });
}

describe('время на подключение до старта (BOT-7, design D10)', () => {
  it('умолчание дедлайна бота-заполнителя — две минуты', () => {
    expect(policy().botFillMs).toBe(120_000);
    expect(STAND_DEFAULTS.botFillMs).toBe(120_000);
  });

  it('флаг перекрывает умолчание: одиночная игра сажает бота сразу', () => {
    expect(policy({ 'bot-fill-ms': '0' }).botFillMs).toBe(0);
    expect(policy({ 'bot-fill-ms': '5000' }).botFillMs).toBe(5000);
  });

  it('отладочный прогон по-прежнему не ждёт никого (CLI-11)', () => {
    expect(policy({}, true).botFillMs).toBe(DEBUG_BOT_FILL_MS);
    expect(DEBUG_BOT_FILL_MS).toBe(0);
    // Флаг сильнее и в отладочном прогоне: он называет величину явно.
    expect(policy({ 'bot-fill-ms': '250' }, true).botFillMs).toBe(250);
  });
});

describe('политика разрыва в бою (BOT-14, design D7)', () => {
  it('умолчание — бот-заместитель с небольшой паузой', () => {
    expect(policy().onDisconnect).toBe('bot');
    expect(policy().substituteDelayMs).toBe(2000);
  });

  it('«ничего» называется явно и читается как есть', () => {
    expect(policy({ 'on-disconnect': 'hold' }).onDisconnect).toBe('hold');
  });

  it('неизвестная политика — отказ, а не тихое умолчание', () => {
    expect(() => policy({ 'on-disconnect': 'none' })).toThrow(/on-disconnect/);
  });

  it('пауза до посадки задаётся флагом', () => {
    expect(policy({ 'substitute-delay-ms': '5000' }).substituteDelayMs).toBe(5000);
  });
});

describe('окно возврата (NTR-6, NTR-17, design D7)', () => {
  it('без флага действует величина ДОКУМЕНТА матча', () => {
    expect(policy().silenceSeconds).toBe(DOCUMENT_SILENCE_SECONDS);
  });

  it('флаг перекрывает документ на один запуск', () => {
    expect(policy({ 'silence-seconds': '10' }).silenceSeconds).toBe(10);
  });
});
