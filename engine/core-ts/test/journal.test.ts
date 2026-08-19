/**
 * Журнал боя (DIAG-10) — производная проекция трейса.
 *
 * Фикстуры здесь СВОИ: строки трейса собираются прямо в тесте, а не читаются из
 * дерева контента (CONT-4). Предмет проверки — инструмент, а не игра: он не
 * знает ни одного игрового события, и словарь ниже — такая же фикстура, как
 * сцена в `system.test.ts`. Покрытие настоящего словаря демо событиями его
 * сцены стережёт тест В ДЕМО, которому дерево контента читать законно (CONT-1).
 */
import { describe, expect, it } from 'vitest';
import {
  JOURNAL_ASSERT,
  JOURNAL_INVARIANT,
  JOURNAL_MESSAGE,
  JOURNAL_UNKNOWN,
  buildJournal,
  journalJsonl,
  journalText,
  parseJournalDictionary,
  type JournalDictionary,
} from '../src/sim/journal.js';
import { traceLine } from '../src/sim/trace.js';
import type { DiagnosticRecord } from '../src/types.js';

/** Словарь-фикстура: те же роли, что у настоящего словаря игры, но события свои. */
const DICTIONARY: JournalDictionary = parseJournalDictionary(
  {
    events: {
      Hit: { kind: 'hit', actor: 'source', target: 'entity' },
      Damage: { kind: 'damage', target: 'entity' },
      Died: { kind: 'death', target: 'entity' },
    },
  },
  'фикстура',
);

function trace(...lines: readonly (DiagnosticRecord | Record<string, unknown>)[]): string {
  return lines.map((line) => traceLine(line as DiagnosticRecord)).join('\n') + '\n';
}

function event(
  tick: number,
  seq: number,
  data: Record<string, number | string>,
  system = 'Combat',
): DiagnosticRecord {
  return { tick, seq, system, kind: 'event', level: 'info', code: 'EVENT', data };
}

describe('DIAG-10: журнал — чистая функция трейса', () => {
  it('повторная сборка из одного файла даёт побитово тот же журнал', () => {
    const text = trace(
      event(1, 0, { type: 'Hit', source: 7, entity: 9, x: 65536 }),
      event(1, 1, { type: 'Damage', entity: 9, amount: 131072 }),
    );
    const first = journalJsonl(buildJournal(text, DICTIONARY).entries);
    const second = journalJsonl(buildJournal(text, DICTIONARY).entries);
    expect(second).toBe(first);
    // Ключи каждой строки — каноническим порядком (SER-6): сравнение построчное.
    expect(first.split('\n')[0]).toBe(
      '{"actor":7,"kind":"hit","params":{"x":65536},"seq":0,"system":"Combat","target":9,"tick":1,"type":"Hit"}',
    );
  });

  it('роли задаёт словарь, остальные поля идут параметрами целиком', () => {
    const { entries } = buildJournal(
      trace(event(4, 2, { type: 'Hit', source: 7, entity: 9, x: 65536, y: -65536 })),
      DICTIONARY,
    );
    expect(entries).toEqual([
      {
        tick: 4,
        seq: 2,
        system: 'Combat',
        kind: 'hit',
        type: 'Hit',
        actor: 7,
        target: 9,
        // Значения — целыми Q16.16 как есть (FP-1): пересчёт в дробь потерял бы
        // точность и завёл вопрос о правилах округления.
        params: { x: 65536, y: -65536 },
      },
    ]);
  });

  it('событие без источника урона даёт запись без актора — журнал его не додумывает', () => {
    const { entries } = buildJournal(trace(event(3, 0, { type: 'Damage', entity: 9, amount: 65536 })), DICTIONARY);
    expect(entries[0]!.actor).toBeUndefined();
    expect(entries[0]).toMatchObject({ kind: 'damage', target: 9, params: { amount: 65536 } });
  });

  it('роль, названная словарём, но отсутствующая в событии, не теряет поле события', () => {
    // Словарь называет актором `source`, а событие его не несёт: цель на месте,
    // актора нет, и ни одно поле события не пропало.
    const { entries } = buildJournal(trace(event(3, 0, { type: 'Hit', entity: 9, amount: 65536 })), DICTIONARY);
    expect(entries[0]).toEqual({
      tick: 3,
      seq: 0,
      system: 'Combat',
      kind: 'hit',
      type: 'Hit',
      target: 9,
      params: { amount: 65536 },
    });
  });

  it('неизвестный тип виден фактом и назван отчётом — отказом прогона это не является', () => {
    const result = buildJournal(trace(event(5, 0, { type: 'BuffApplied', entity: 9, stacks: 2 })), DICTIONARY);
    expect(result.entries[0]).toMatchObject({
      kind: JOURNAL_UNKNOWN,
      type: 'BuffApplied',
      params: { entity: 9, stacks: 2 },
    });
    expect(result.unknownTypes).toEqual(['BuffApplied']);
  });

  it('прогон без словаря законен: факты собраны, семантика у всех неизвестная', () => {
    const result = buildJournal(trace(event(1, 0, { type: 'Hit', source: 7, entity: 9 })));
    expect(result.entries[0]!.kind).toBe(JOURNAL_UNKNOWN);
    expect(result.entries[0]!.params).toEqual({ entity: 9, source: 7 });
    expect(result.unknownTypes).toEqual(['Hit']);
  });
});

describe('DIAG-10: дефект прогона виден в журнале боя', () => {
  it('жёсткая граница попадает в журнал без словаря, рядом с боевыми фактами', () => {
    const result = buildJournal(
      trace(
        event(9, 0, { type: 'Hit', source: 7, entity: 9 }),
        {
          tick: 9,
          seq: 1,
          system: 'Combat',
          kind: 'invariant',
          level: 'error',
          code: 'FIXED_OVERFLOW',
          message: 'переполнение Q16.16',
        },
        {
          tick: 9,
          seq: 2,
          kind: 'assert',
          level: 'warn',
          code: 'ASSERT',
          message: 'мягкая диагностика',
        },
      ),
      DICTIONARY,
    );
    expect(result.entries.map((entry) => entry.kind)).toEqual(['hit', JOURNAL_INVARIANT, JOURNAL_ASSERT]);
    expect(result.entries[1]).toEqual({
      tick: 9,
      seq: 1,
      system: 'Combat',
      kind: JOURNAL_INVARIANT,
      type: 'FIXED_OVERFLOW',
      params: { [JOURNAL_MESSAGE]: 'переполнение Q16.16' },
    });
    // Код записи о дефекте словаря не требует: инструмент о нём и не спрашивал.
    expect(result.unknownTypes).toEqual([]);
  });

  it('текст записи не затирает одноимённое поле данных прогона', () => {
    const result = buildJournal(
      trace({
        tick: 4,
        seq: 0,
        kind: 'invariant',
        level: 'error',
        code: 'INVARIANT',
        // `message` в данных — законный скаляр прогона (DIAG-2), и потерять его
        // ради текста инструмента журнал не вправе.
        data: { message: 42 },
        message: 'текст инструмента',
      }),
      DICTIONARY,
    );
    expect(result.entries[0]?.params).toEqual({ message: 42, [JOURNAL_MESSAGE]: 'текст инструмента' });
  });

  it('границы систем, команды и сводка стоимости боевыми фактами не являются', () => {
    const result = buildJournal(
      trace(
        { tick: 1, seq: 0, system: 'Combat', kind: 'systemBegin', level: 'info', code: 'SYSTEM_BEGIN' },
        { tick: 1, seq: 1, system: 'Combat', kind: 'command', level: 'info', code: 'COMMAND', outcome: 'applied' },
        { tick: 1, seq: 2, kind: 'tickCost', level: 'info', code: 'TICK_COST', data: { expressions: 3 } },
      ),
      DICTIONARY,
    );
    expect(result.entries).toEqual([]);
  });
});

describe('DIAG-9: ветвь истории в журнале', () => {
  const REWOUND = trace(
    { mark: 'live', epoch: 0, tick: 10 },
    event(10, 0, { type: 'Died', entity: 9 }),
    { mark: 'replayBegin', epoch: 0, tick: 8 },
    event(10, 0, { type: 'Died', entity: 9 }),
    { mark: 'replayEnd', epoch: 0, tick: 8 },
    { mark: 'live', epoch: 1, tick: 9 },
    event(9, 0, { type: 'Hit', source: 7, entity: 9 }),
  );

  it('переисполненный проход отличается от живого по отметкам хоста', () => {
    const { entries } = buildJournal(REWOUND, DICTIONARY);
    expect(entries.map((entry) => entry.branch)).toEqual(['0', '0:replay', '1']);
  });

  it('одна смерть в живой ветви не показывается дважды', () => {
    const { entries } = buildJournal(REWOUND, DICTIONARY);
    const deaths = entries.filter((entry) => entry.kind === 'death' && entry.branch === '0');
    expect(deaths).toHaveLength(1);
  });

  it('трейс без отметок ветви не несёт: поля branch в записях нет', () => {
    const { entries } = buildJournal(trace(event(1, 0, { type: 'Died', entity: 9 })), DICTIONARY);
    expect(entries[0]!.branch).toBeUndefined();
  });
});

describe('CLI-7: разбор построчный, а не файлом целиком', () => {
  it('усечённый хвост оборванного прогона теряет одну строку, а не журнал', () => {
    const text = trace(event(1, 0, { type: 'Died', entity: 9 })) + '{"tick":2,"seq":0,"kin';
    const result = buildJournal(text, DICTIONARY);
    expect(result.entries).toHaveLength(1);
    expect(result.malformedLines).toBe(1);
  });
});

describe('DIAG-10: человеческая форма — те же поля колонками', () => {
  it('колонки собираются из полей записи, без текста на естественном языке', () => {
    const { entries } = buildJournal(
      trace(event(4, 2, { type: 'Hit', source: 7, entity: 9, x: 65536 })),
      DICTIONARY,
    );
    const lines = journalText(entries).split('\n');
    expect(lines[0]!.split(/\s+/)).toEqual([
      'tick',
      'seq',
      'branch',
      'kind',
      'type',
      'actor',
      'target',
      'system',
      'params',
    ]);
    expect(lines[1]!.split(/\s+/)).toEqual(['4', '2', '-', 'hit', 'Hit', '7', '9', 'Combat', 'x=65536']);
  });
});

describe('DIAG-10: словарь — документ, и он проверяется', () => {
  it('семантика без кода факта — отказ разбора, а не факт без имени', () => {
    expect(() => parseJournalDictionary({ events: { Hit: { target: 'entity' } } }, 'словарь')).toThrow(
      /нет непустого "kind"/,
    );
  });

  it('роль — имя поля события, то есть строка', () => {
    expect(() => parseJournalDictionary({ events: { Hit: { kind: 'hit', target: 3 } } }, 'словарь')).toThrow(
      /роль "target"/,
    );
  });

  it('документ без объекта events разбору не подлежит', () => {
    expect(() => parseJournalDictionary({ Hit: { kind: 'hit' } }, 'словарь')).toThrow(/нет объекта "events"/);
  });
});
