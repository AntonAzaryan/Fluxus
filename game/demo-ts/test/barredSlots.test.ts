/**
 * Переезд запертых слотов в следующий круг стенда (`netcode-transport` NTR-19,
 * `server-control` SRV-5).
 *
 * Предмет — не сам запрет (он проверен на сервере, `engine/net-ts`), а то, что
 * круг, который из-за него не начнётся, СКАЖЕТ об этом. Круг с запертым слотом
 * стоит в лобби молча по построению: занять слот некому — заполнитель его не
 * предлагает, заместителя в него не сажают, — а «бот не занял ни одного слота»
 * для запертого слота подавлено намеренно. Оператору при этом остаётся стенд,
 * который выглядит зависшим, и команда `unbar`, о которой ему никто не напомнил.
 */
import { describe, expect, it } from 'vitest';
import { carryBarredSlots, seatingIsStandFailure } from '../app/barredSlots.js';

const PLAYERS = ['p1', 'p2'] as const;

/** Пустая посадка в лобби без запертых слотов — то самое, что стенд валит. */
const EMPTY = { taken: 0, rejections: [], lobby: true, barred: false };

describe('запреты переживают круг и называются вслух (NTR-19, SRV-5)', () => {
  it('перенесённый запрет назван игроком и способом снять его', () => {
    const carried = carryBarredSlots([0], PLAYERS);
    expect(carried.slots).toEqual([0]);
    // Имя игрока, а не номер слота: в отчёте стенда оператор видит имена.
    expect(carried.note).toContain('"p1"');
    // И восстановление названо: оно единственное (SRV-5).
    expect(carried.note).toContain('unbar');
  });

  it('запретов нет — стенд молчит: строка о пустом переезде была бы шумом', () => {
    const carried = carryBarredSlots([], PLAYERS);
    expect(carried.slots).toEqual([]);
    expect(carried.note).toBe('');
  });

  it('несколько запертых слотов названы все и по порядку', () => {
    const carried = carryBarredSlots(new Set([1, 0]), PLAYERS);
    expect(carried.slots).toEqual([0, 1]);
    expect(carried.note).toContain('"p1"');
    expect(carried.note).toContain('"p2"');
  });

  it('слот вне ростера не переезжает: `host.bar` не получает номера, которого нет', () => {
    const carried = carryBarredSlots([0, 2, -1], PLAYERS);
    expect(carried.slots).toEqual([0]);
  });
});

describe('запертый слот — не отказ стенда (NTR-19, BOT-7)', () => {
  it('пустая посадка в лобби без запретов остаётся отказом стенда', () => {
    // Контроль: без запретов диагноз работает как работал — иначе проверки ниже
    // утверждали бы, что стенд не жалуется никогда.
    expect(seatingIsStandFailure(EMPTY)).toBe(true);
  });

  it('«бот получил slot-taken на слот человека» при запертом соседе круг НЕ валит', () => {
    // Живой путь, на котором прежняя оговорка не срабатывала: круг перенёс
    // запрет, вернувшийся человек взвёл дедлайн, заполнитель предложил бота на
    // ЕГО слот (запертый он уже выкинул сам), сервер ответил `slot-taken`.
    // Занятых ноль, фаза `lobby`, `slot-barred` никто не называл — и стенд ронял
    // круг вместе с сидящим в нём человеком, а под агентом это давало `crashed`
    // и постмортем (SRV-6) на осознанное действие админа.
    expect(
      seatingIsStandFailure({ ...EMPTY, rejections: ['slot-taken'], barred: true }),
    ).toBe(false);
  });

  it('запертый слот в ростере молчит и без единого отказа в отчёте', () => {
    // Заполнитель мог не предложить НИЧЕГО («свободных незапертых слотов нет»),
    // и тогда отказов в отчёте нет вовсе. Судить по ним было бы нечем.
    expect(seatingIsStandFailure({ ...EMPTY, barred: true })).toBe(false);
  });

  it('отказ `slot-barred` остаётся поводом смолчать: запереть могли в гонке', () => {
    // Ростер уже чист (запрет сняли), а отказ ещё в пути — один и тот же факт с
    // двух сторон, и решать его гонкой нельзя.
    expect(
      seatingIsStandFailure({ ...EMPTY, rejections: ['slot-barred: слот 0 заперт'] }),
    ).toBe(false);
  });

  it('идущий круг и занятые места диагнозу не подлежат', () => {
    // Отказ заместителю посреди боя — не отказ стенда: матч идёт.
    expect(seatingIsStandFailure({ ...EMPTY, lobby: false, rejections: ['slot-taken'] })).toBe(false);
    expect(seatingIsStandFailure({ ...EMPTY, taken: 1 })).toBe(false);
  });
});
