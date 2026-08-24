/**
 * Трейс авторитетного матча (DIAG-8, DIAG-9): подключение sink'а хостом,
 * отметки ветви истории, отбор записей и отказ записи.
 *
 * Главная проверка здесь — инертность: отладочный матч обязан быть ТЕМ ЖЕ
 * матчем. Всё остальное имеет смысл только если она выполняется — трейс,
 * меняющий ход матча, показывал бы не бой, а собственное присутствие.
 *
 * Матч ведётся прямыми вызовами `MatchServer` (NTR-3), без транспорта:
 * предмет — сервер и его границы ветвей, а доставка добавила бы к сравнению
 * своё расписание.
 */
import { describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_CODES,
  snapshotToPlain,
  type DiagnosticRecord,
  type GameEvent,
  type SceneDef,
} from '@fluxus/core';
import { createMatchTrace } from '../src/match/trace.js';
import { parseServerMessage } from '../src/protocol/messages.js';
import { MatchServer, type MatchConfig } from '../src/server/matchServer.js';
import { duelConfig, duelScene, hello, inputMessage, versionOf, wireInput, STEP } from './fixtures.js';

const TICKS = 12;
/** Бит каста: по его фронту сцена ниже публикует событие. */
const CAST_BUTTON = 0;

/** Дуэль плюс публикация события по фронту кнопки — тот же приём, что в `events.test.ts`. */
function castScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Cast',
        order: 20,
        query: { all: ['Input', 'Player'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'buttons'] }, CAST_BUTTON] },
                  { '!': [{ bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'prevButtons'] }, CAST_BUTTON] }] },
                ],
              },
              then: [
                {
                  emitEvent: {
                    type: 'Cast',
                    data: {
                      entity: { var: 'e' },
                      slot: { getComponent: [{ var: 'e' }, 'Player', 'slot'] },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function castConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  const scene = castScene();
  return duelConfig({ scene, version: versionOf(scene), ...overrides });
}

interface Played {
  readonly server: MatchServer;
  /** Персональные снапшоты обоих слотов по тикам — канонический байтовый след матча. */
  readonly snapshots: readonly string[];
  readonly events: readonly (readonly GameEvent[])[];
}

/**
 * Матч прямыми вызовами: приветствие обоих слотов запускает его, дальше — ввод
 * и тик. Ввод — функция номера тика и слота, поэтому два прогона одного конфига
 * различаться могут только тем, что мы в них меняем.
 */
function playDirect(config: MatchConfig, ticks: number = TICKS): Played {
  const server = new MatchServer(config);
  server.connect(1);
  server.connect(2);
  server.receive(1, hello('p1', config.version));
  server.receive(2, hello('p2', config.version));
  server.drain();

  const snapshots: string[] = [];
  const events: GameEvent[][] = [];
  for (let i = 0; i < ticks; i++) {
    const tick = server.tick + 1 + config.inputDelay!;
    // Кнопка каста жмётся через тик — фронт по каждому нажатию, то есть поток
    // событий на всём протяжении матча.
    const buttons = i % 2 === 0 ? 1 << CAST_BUTTON : 0;
    server.receive(1, inputMessage(wireInput(tick, i, STEP, 0, buttons)));
    server.receive(2, inputMessage(wireInput(tick, i, 0, STEP, 0)));
    server.advance();
    server.drain();
    snapshots.push(JSON.stringify(snapshotToPlain(server.snapshot(0))));
    snapshots.push(JSON.stringify(snapshotToPlain(server.snapshot(1))));
    events.push([...server.snapshot(0).events]);
  }
  return { server, snapshots, events };
}

function collect(): { readonly lines: string[]; readonly write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

describe('DIAG-8: отладочный матч — тот же матч', () => {
  it('sink полного уровня не меняет ни лог, ни снапшоты, ни события', () => {
    const sink = collect();
    const traced = playDirect(castConfig({ trace: createMatchTrace('full', undefined, sink.write) }));
    const plain = playDirect(castConfig());

    // Контроль: трейс действительно снимался — иначе сравнивать было бы нечего.
    expect(sink.lines.length).toBeGreaterThan(0);

    expect(traced.server.canonicalInputs).toEqual(plain.server.canonicalInputs);
    expect(traced.snapshots).toEqual(plain.snapshots);
    expect(traced.events).toEqual(plain.events);
    expect(traced.server.worldInitHash).toBe(plain.server.worldInitHash);
  });

  it('записи диагностики не уезжают клиенту ни одним сообщением (NET-18)', () => {
    const sink = collect();
    const config = castConfig({ trace: createMatchTrace('full', undefined, sink.write) });
    const server = new MatchServer(config);
    server.connect(1);
    server.connect(2);
    server.receive(1, hello('p1', config.version));
    server.receive(2, hello('p2', config.version));
    const outgoing = server.drain();
    server.advance();
    outgoing.push(...server.drain());

    expect(sink.lines.length).toBeGreaterThan(0);
    expect(outgoing.length).toBeGreaterThan(0);
    for (const out of outgoing) {
      // Состав сообщений закрыт (NTR-4), и проверяется он тем самым разбором,
      // которым сообщение принимает клиент: `parseServerMessage` собирает поля
      // ПОИМЁННО, поэтому лишнее поле — хоть `trace` на `Welcome`, хоть блоб с
      // данными — до него не доживает, и равенство расходится. Утверждение о
      // двух подстроках такой утечки не заметило бы.
      expect(parseServerMessage(out.message)).toEqual(out.message);
    }

    // Второй заход, структурный: ни один вложенный объект сообщения не имеет
    // формы записи диагностики (DIAG-2) и ни одна строка в нём не является её
    // кодом. Переименованный код или чужое поле краснеют здесь, даже если
    // разбор их случайно пропустил.
    for (const out of outgoing) expect(diagnosticsInside(out.message)).toEqual([]);
  });
});

/**
 * Следы диагностики в произвольном значении: форма записи (DIAG-2 — `seq` плюс
 * `kind` плюс `code`) и любой стабильный код записи, встреченный строкой.
 */
function diagnosticsInside(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return (DIAGNOSTIC_CODES as readonly string[]).includes(value) ? [`${path} = ${value}`] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => diagnosticsInside(item, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const found: string[] = [];
  if ('seq' in record && 'kind' in record && 'code' in record) found.push(`${path} — форма записи DIAG-2`);
  for (const [key, item] of Object.entries(record)) found.push(...diagnosticsInside(item, `${path}.${key}`));
  return found;
}

describe('CLI-11/CLI-10: отладочные поля в запись матча не попадают', () => {
  it('состав документа записи тот же, что без трейса', () => {
    const sink = collect();
    const traced = playDirect(castConfig({ trace: createMatchTrace('full', undefined, sink.write) }));
    const plain = playDirect(castConfig());
    expect(traced.server.toScenario()).toEqual(plain.server.toScenario());
    expect(JSON.stringify(traced.server.toScenario())).not.toContain('trace');
  });
});

describe('DIAG-8: отказ записи гасит трейс, а не матч', () => {
  it('писатель, роняющий ошибку, назван отчётом, а матч доигран', () => {
    let written = 0;
    const trace = createMatchTrace('full', undefined, () => {
      written++;
      throw new Error('нет места на диске');
    });
    const traced = playDirect(castConfig({ trace }));
    const plain = playDirect(castConfig());

    // Матч дошёл до конца и совпал с прогоном без трейса: наблюдатель не убил
    // наблюдаемое, и исключение в тик не ушло (DIAG-4).
    expect(traced.snapshots).toEqual(plain.snapshots);
    expect(traced.server.tick).toBe(plain.server.tick);
    // Первая ошибка запомнена и названа, дальше писать не пытались.
    expect(trace.failure).toBe('нет места на диске');
    expect(written).toBe(1);
  });

  it('упавший ОТБОР тоже не уходит в тик: под охраной всё тело съёма (DIAG-4)', () => {
    // Предикат приходит от запускалки — из командной строки, — и исключение из
    // него для ядра неотличимо от исключения писателя: DIAG-4 объявляет любое
    // исключение из sink'а дефектом хоста, а debug-сборка ядра превращает его в
    // жёсткую границу. То есть кривой отбор убивал бы матч.
    const trace = createMatchTrace('full', () => {
      throw new Error('отбор упал');
    }, () => {});
    const traced = playDirect(castConfig({ trace }));
    const plain = playDirect(castConfig());

    expect(traced.snapshots).toEqual(plain.snapshots);
    expect(trace.failure).toBe('отбор упал');
  });
});

describe('DIAG-9: отбор записей — чистая функция от записи', () => {
  const isEvent = (entry: DiagnosticRecord): boolean => entry.kind === 'event';

  it('отобранный трейс содержит только выбранные записи; отметки хоста отбору не подлежат', () => {
    const sink = collect();
    playDirect(castConfig({ trace: createMatchTrace('full', isEvent, sink.write) }));
    const parsed = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const records = parsed.filter((value) => !('mark' in value));
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect(record).toMatchObject({ kind: 'event' });
    // Отметка — строка ХОСТА, а не запись ядра (DIAG-9): отбор по виду записи к
    // ней неприменим, иначе отобранный трейс потерял бы адресацию по ветвям.
    expect(parsed.some((value) => 'mark' in value)).toBe(true);
  });

  it('два прогона одной записи с тем же отбором дают тот же файл', () => {
    const first = collect();
    const second = collect();
    const config = castConfig();
    playDirect({ ...config, trace: createMatchTrace('full', isEvent, first.write) });
    playDirect({ ...config, trace: createMatchTrace('full', isEvent, second.write) });
    expect(second.lines).toEqual(first.lines);
  });

  it('записи о нарушенных инвариантах отбор не выбрасывает никогда (FP-4)', () => {
    const sink = collect();
    // Отбор, не пропускающий вообще ничего: сигнал о дефекте обязан пройти
    // сквозь него — DIAG-3 вывела такие записи из-под регулятора объёма.
    const trace = createMatchTrace('systems', () => false, sink.write);
    trace.sink.record({
      tick: 3,
      seq: 0,
      kind: 'invariant',
      level: 'error',
      code: 'FIXED_OVERFLOW',
      message: 'переполнение',
    });
    trace.sink.record({ tick: 3, seq: 1, kind: 'assert', level: 'warn', code: 'ASSERT', message: 'мягкая' });
    trace.sink.record({ tick: 3, seq: 2, kind: 'tickCost', level: 'info', code: 'TICK_COST' });
    expect(sink.lines).toHaveLength(2);
    expect(sink.lines.map((line) => (JSON.parse(line) as DiagnosticRecord).code)).toEqual([
      'FIXED_OVERFLOW',
      'ASSERT',
    ]);
  });
});

describe('DIAG-9: отметки ветви истории', () => {
  it('живой тик отмечен эпохой и номером, отметка отличима от записи по признаку', () => {
    const sink = collect();
    playDirect(castConfig({ trace: createMatchTrace('systems', undefined, sink.write) }), 3);
    const marks = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((v) => 'mark' in v);
    expect(marks).toEqual([
      { mark: 'live', epoch: 0, tick: 1 },
      { mark: 'live', epoch: 0, tick: 2 },
      { mark: 'live', epoch: 0, tick: 3 },
    ]);
    // Данных окружения в отметке нет — ни времени, ни идентификатора процесса.
    for (const mark of marks) expect(Object.keys(mark).sort()).toEqual(['epoch', 'mark', 'tick']);
  });

  it('отметка стоит ПЕРЕД записями своего тика: читателю не нужно забегать вперёд', () => {
    const sink = collect();
    playDirect(castConfig({ trace: createMatchTrace('systems', undefined, sink.write) }), 2);
    const kinds = sink.lines.map((line) => {
      const value = JSON.parse(line) as Record<string, unknown>;
      return 'mark' in value ? `mark:${String(value.tick)}` : `tick:${String(value.tick)}`;
    });
    expect(kinds[0]).toBe('mark:1');
    expect(kinds[1]).toBe('tick:1');
    expect(kinds.indexOf('mark:2')).toBeLessThan(kinds.indexOf('tick:2'));
  });

  it('реплей внутри seekTo обёрнут своей парой отметок (REW-4, WSM-6)', () => {
    const sink = collect();
    // Интервал крупнее шага перемотки намеренно: ближайший снапшот тогда лежит
    // ПОЗАДИ цели, и `seekTo` действительно доигрывает вперёд реплеевыми тиками
    // (REW-2), а не восстанавливает точное состояние без единого тика.
    const config = castConfig({
      trace: createMatchTrace('systems', undefined, sink.write),
      rewind: { interval: 4, capacity: 32 },
    });
    const played = playDirect(config, 8);
    played.server.pause();
    played.server.beginRewind();
    played.server.seekTo(6);

    const marks = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((value) => 'mark' in value);
    expect(marks.slice(-2)).toEqual([
      { mark: 'replayBegin', epoch: 0, tick: 6 },
      { mark: 'replayEnd', epoch: 0, tick: 6 },
    ]);
    // Переисполненные тики лежат МЕЖДУ отметками — иначе их нельзя было бы
    // отличить от живых по номеру тика.
    const begin = sink.lines.findIndex((line) => line.includes('"replayBegin"'));
    const end = sink.lines.findIndex((line) => line.includes('"replayEnd"'));
    expect(end).toBeGreaterThan(begin + 1);
  });
});
