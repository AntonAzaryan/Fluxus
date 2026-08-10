/**
 * Диагностика и трейс ядра (DIAG-1..7, DI-5, CLI-7).
 *
 * Главный тест здесь — инертность: приёмник обязан быть наблюдателем, а не
 * участником расчёта. Всё остальное имеет смысл только если он выполняется.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mathApi } from '../src/math/mathApi.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { createWorld, spawn } from '../src/ecs/world.js';
import { initialState, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { runScenarioBytes, type ScenarioDef } from '../src/sim/scenario.js';
import { createJsonlSink } from '../src/sim/trace.js';
import type { PrefabDef } from '../src/ecs/world.js';
import type {
  ComponentSchema,
  DiagnosticRecord,
  DiagnosticsSink,
  SimulationState,
  System,
  TraceLevel,
} from '../src/types.js';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');
const decoder = new TextDecoder();
const WORLD_SEED = 4242;

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Health', fields: { current: 'fixed' } },
];

const PREFABS: PrefabDef[] = [
  { name: 'unit', components: { Position: { x: 0, y: 0 }, Health: { current: 65536 } } },
];

function collector(trace: TraceLevel): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace, record: (entry) => entries.push(entry) }, entries };
}

function makeSim(systems: System[], diagnostics?: DiagnosticsSink): Simulation {
  const registry = new SystemRegistry();
  for (const system of systems) registry.register(system);
  return {
    systems: registry,
    worldSeed: WORLD_SEED,
    math: mathApi,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  };
}

function freshState(units = 1): SimulationState {
  const world = createWorld(SCHEMAS, PREFABS);
  for (let i = 0; i < units; i++) spawn(world, 'unit');
  return initialState(world, WORLD_SEED);
}

function loadScenario(name: string): ScenarioDef {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.scenario.json`), 'utf8')) as ScenarioDef;
}

/** Прогон сценария с трейсом: возвращает и документ CLI-3, и строки трейса. */
function runWithTrace(def: ScenarioDef, trace: TraceLevel): { output: string; lines: string[] } {
  const lines: string[] = [];
  const sink = createJsonlSink(trace, (line) => lines.push(line));
  return { output: decoder.decode(runScenarioBytes(def, sink)), lines };
}

describe('DIAG-4/DI-5: приёмник инертен для симуляции', () => {
  for (const name of ['burning', 'movement', 'arena-time']) {
    it(`${name}: прогон с трейсом и без даёт побитово один документ`, () => {
      const def = loadScenario(name);
      const withoutSink = decoder.decode(runScenarioBytes(def));
      expect(runWithTrace(def, 'full').output).toBe(withoutSink);
      expect(runWithTrace(def, 'systems').output).toBe(withoutSink);
      expect(runWithTrace(def, 'off').output).toBe(withoutSink);
    });
  }

  it('исключение приёмника ловится в debug-сборке, а не портит мир молча', () => {
    const boom: DiagnosticsSink = {
      trace: 'full',
      record: () => {
        throw new Error('приёмник сломан');
      },
    };
    const system: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 1); },
    };
    const state = freshState();
    expect(() => tick(makeSim([system], boom), state)).toThrow(/sink диагностики бросил/);
  });
});

describe('DIAG-6: трейс детерминирован', () => {
  it('два прогона одного сценария дают побитово один трейс', () => {
    const def = loadScenario('burning');
    expect(runWithTrace(def, 'full').lines).toEqual(runWithTrace(def, 'full').lines);
  });

  it('в записи нет отметки реального времени (DIAG-2)', () => {
    const lines = runWithTrace(loadScenario('burning'), 'full').lines;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry.timestamp).toBeUndefined();
      expect(entry.time).toBeUndefined();
      expect(typeof entry.tick).toBe('number');
      expect(typeof entry.seq).toBe('number');
    }
  });

  it('ключи записи отсортированы канонически — построчное сравнение не зависит от порядка вставки', () => {
    const line = runWithTrace(loadScenario('burning'), 'full').lines[0]!;
    const keys = Object.keys(JSON.parse(line) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });
});

describe('DIAG-5: трейс потока Command Buffer', () => {
  it('команда к убитой в этом же тике сущности — исход dropped:dead-target', () => {
    const killer: System = {
      name: 'Killer',
      order: 1,
      run: (ctx) => { ctx.commands.destroy(ctx.query({ all: ['Health'] })[0]!); },
    };
    // Цель захватывается до тика: после `Killer` запрос её уже не вернёт.
    const state = freshState();
    let victim = 0;
    const capture: System = {
      name: 'Capture',
      order: 0,
      run: (ctx) => {
        victim = ctx.query({ all: ['Health'] })[0]!;
      },
    };
    const writer: System = {
      name: 'Writer',
      order: 2,
      run: (ctx) => { ctx.commands.setField(victim, 'Health', 'current', 999); },
    };

    const { sink, entries } = collector('full');
    tick(makeSim([capture, killer, writer], sink), state);

    const dropped = entries.filter((e) => e.outcome === 'dropped:dead-target');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.system).toBe('Writer');
    expect(dropped[0]?.data).toMatchObject({ cmd: 'setField', component: 'Health', field: 'current' });
  });

  it('две записи одного поля в одной системе — первая перекрыта, вторая применена (CMD-3)', () => {
    const doubleWriter: System = {
      name: 'DoubleWriter',
      order: 1,
      run: (ctx) => {
        const entity = ctx.query({ all: ['Health'] })[0]!;
        ctx.commands.setField(entity, 'Health', 'current', 111);
        ctx.commands.setField(entity, 'Health', 'current', 222);
      },
    };
    const { sink, entries } = collector('full');
    tick(makeSim([doubleWriter], sink), freshState());

    const commands = entries.filter((e) => e.kind === 'command');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ outcome: 'overwritten', data: { value: 111 } });
    expect(commands[1]).toMatchObject({ outcome: 'applied', data: { value: 222 } });
  });

  it('каждая запись о команде несёт имя заказавшей системы', () => {
    const writer: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const { sink, entries } = collector('full');
    tick(makeSim([writer], sink), freshState());
    for (const entry of entries.filter((e) => e.kind === 'command')) {
      expect(entry.system).toBe('Writer');
    }
  });

  it('порядок задаётся seq: событие, опубликованное до команды, имеет меньший номер (DIAG-2)', () => {
    const mixed: System = {
      name: 'Mixed',
      order: 1,
      run: (ctx) => {
        ctx.events.emit('Before');
        ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 7);
        ctx.events.emit('After');
      },
    };
    const { sink, entries } = collector('full');
    tick(makeSim([mixed], sink), freshState());

    const before = entries.find((e) => e.kind === 'event' && e.data?.type === 'Before')!;
    const command = entries.find((e) => e.kind === 'command')!;
    const after = entries.find((e) => e.kind === 'event' && e.data?.type === 'After')!;
    expect(before.seq).toBeLessThan(command.seq);
    expect(command.seq).toBeLessThan(after.seq);
  });
});

describe('DIAG-3: уровни детализации', () => {
  it('пустой отбор запроса виден на уровне границ систем', () => {
    const idle: System = {
      name: 'Idle',
      order: 1,
      run: (ctx) => {
        ctx.query({ all: ['NoSuchComponent'] });
      },
    };
    const { sink, entries } = collector('systems');
    tick(makeSim([idle], sink), freshState());

    const end = entries.find((e) => e.kind === 'systemEnd')!;
    expect(end.system).toBe('Idle');
    expect(end.data).toMatchObject({ queries: 1, matched: 0, commands: 0 });
  });

  it('уровень границ систем не пишет поток команд', () => {
    const writer: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const { sink, entries } = collector('systems');
    tick(makeSim([writer], sink), freshState());

    expect(entries.some((e) => e.kind === 'command')).toBe(false);
    expect(entries.find((e) => e.kind === 'systemEnd')?.data).toMatchObject({ commands: 1, applied: 1 });
  });

  it('выключенный трейс не пишет ничего штатного', () => {
    const writer: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const { sink, entries } = collector('off');
    tick(makeSim([writer], sink), freshState());
    expect(entries).toHaveLength(0);
  });
});

describe('DIAG-7: диагностика недостижима изнутри симуляции', () => {
  it('записей нет в TickResult', () => {
    const writer: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const { sink } = collector('full');
    const result = tick(makeSim([writer], sink), freshState());
    expect(Object.keys(result).sort()).toEqual(['changes', 'events', 'isReplay', 'mode', 'state', 'tick']);
  });

  it('снапшот тика с трейсом идентичен снапшоту тика без него', () => {
    const writer: System = {
      name: 'Writer',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const { sink } = collector('full');

    const traced = freshState();
    tick(makeSim([writer], sink), traced);
    const plain = freshState();
    tick(makeSim([writer]), plain);

    expect(JSON.stringify(takeSnapshot(traced).world)).toBe(JSON.stringify(takeSnapshot(plain).world));
  });
});

describe('DIAG-1/CLI-7: записи переживают обрыв тика', () => {
  it('система упала посреди тика — уже выданные записи у приёмника, и по ним видно место', () => {
    const good: System = {
      name: 'Good',
      order: 1,
      run: (ctx) => { ctx.commands.setField(ctx.query({ all: ['Health'] })[0]!, 'Health', 'current', 5); },
    };
    const bad: System = {
      name: 'Bad',
      order: 2,
      run: () => {
        throw new Error('падение системы');
      },
    };
    const { sink, entries } = collector('full');
    expect(() => tick(makeSim([good, bad], sink), freshState())).toThrow(/падение системы/);

    expect(entries.some((e) => e.system === 'Good' && e.kind === 'command')).toBe(true);
    // Границу упавшей системы видно: begin есть, а её команд — нет.
    expect(entries.some((e) => e.system === 'Bad' && e.kind === 'systemBegin')).toBe(true);
    expect(entries.some((e) => e.system === 'Bad' && e.kind === 'command')).toBe(false);
  });

  it('каждая строка JSONL парсится самостоятельно, включая усечённый хвост', () => {
    const lines = runWithTrace(loadScenario('burning'), 'full').lines;
    const truncated = lines.slice(0, 3);
    for (const line of truncated) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
