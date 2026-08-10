import { describe, expect, it, vi } from 'vitest';
import { assert, assertInvariant, withDiagnostics } from '../src/debug.js';
import type { DiagnosticRecord, DiagnosticsSink, TraceLevel } from '../src/types.js';

function collector(trace: TraceLevel = 'off'): { sink: DiagnosticsSink; entries: DiagnosticRecord[] } {
  const entries: DiagnosticRecord[] = [];
  return { sink: { trace, record: (entry) => entries.push(entry) }, entries };
}

describe('assert (FP-4): мягкая диагностика, не часть симуляции', () => {
  it('условие истинно — не зовёт sink', () => {
    const { sink, entries } = collector();
    withDiagnostics(sink, 1, () => { assert(true, 'unreachable'); });
    expect(entries).toHaveLength(0);
  });

  it('условие ложно — пишет запись, НЕ бросает исключение', () => {
    const { sink, entries } = collector();
    expect(() => { withDiagnostics(sink, 7, () => { assert(false, 'что-то не так', 'FIXED_OVERFLOW'); }); }).not.toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tick: 7, kind: 'assert', level: 'warn', code: 'FIXED_OVERFLOW' });
    expect(entries[0]?.message).toContain('что-то не так');
  });

  it('без подключённого sink — молчаливо не бросает', () => {
    expect(() => { assert(false, 'без sink'); }).not.toThrow();
  });

  it('уровень трейса `off` не глушит диагностику инвариантов (DIAG-3)', () => {
    const { sink, entries } = collector('off');
    withDiagnostics(sink, 1, () => { assert(false, 'слышно и при выключенном трейсе'); });
    expect(entries).toHaveLength(1);
  });

  it('возвращаемого значения нет — assert не может повлиять на результат вызывающей операции', () => {
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-invalid-void-type -- baseline
    const result: void = assert(false, 'x');
    expect(result).toBeUndefined();
  });
});

describe('assertInvariant (FP-4/ID-1): жёсткая граница, бросает в обоих режимах', () => {
  it('условие истинно — не бросает', () => {
    expect(() => { assertInvariant(true, 'unreachable'); }).not.toThrow();
  });

  it('условие ложно — бросает исключение с сообщением', () => {
    expect(() => { assertInvariant(false, 'граница нарушена'); }).toThrow(/граница нарушена/);
  });

  it('запись уходит ДО броска — она переживает исключение из тика (DIAG-1)', () => {
    const { sink, entries } = collector();
    expect(() =>
      { withDiagnostics(sink, 3, () => { assertInvariant(false, 'x', 'ENTITY_CAPACITY_EXCEEDED'); }); },
    ).toThrow();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ tick: 3, kind: 'invariant', level: 'error', code: 'ENTITY_CAPACITY_EXCEEDED' });
  });

  it('бросает и в release-сборке (DEBUG=false) — не зависит от режима', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    try {
      const release = await import('../src/debug.js');
      expect(release.DEBUG).toBe(false);
      expect(() => { release.assertInvariant(false, 'жёсткая граница'); }).toThrow(/жёсткая граница/);
      expect(() => { release.assert(false, 'мягкая диагностика'); }).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
      vi.resetModules();
    }
  });
});

describe('область действия приёмника (DIAG-1): без модульного синглтона', () => {
  it('приёмник снимается после выхода из области', () => {
    const { sink, entries } = collector();
    withDiagnostics(sink, 1, () => { assert(false, 'внутри'); });
    assert(false, 'снаружи');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toContain('внутри');
  });

  it('вложенные области возвращают предыдущий приёмник, а не обнуляют его', () => {
    const outer = collector();
    const inner = collector();
    withDiagnostics(outer.sink, 1, () => {
      withDiagnostics(inner.sink, 2, () => { assert(false, 'внутренний'); });
      assert(false, 'внешний');
    });
    expect(inner.entries).toHaveLength(1);
    expect(outer.entries).toHaveLength(1);
    expect(outer.entries[0]?.message).toContain('внешний');
  });

  it('исключение из тела не оставляет приёмник установленным', () => {
    const { sink, entries } = collector();
    expect(() =>
      withDiagnostics(sink, 1, () => {
        throw new Error('падение внутри тика');
      }),
    ).toThrow(/падение внутри тика/);
    assert(false, 'после падения');
    expect(entries).toHaveLength(0);
  });

  it('sink, бросивший исключение, ловится в debug-сборке как нарушенный инвариант (DIAG-4)', () => {
    const sink: DiagnosticsSink = {
      trace: 'off',
      record: () => {
        throw new Error('приёмник сломан');
      },
    };
    expect(() => { withDiagnostics(sink, 1, () => { assert(false, 'x'); }); }).toThrow(/sink диагностики бросил/);
  });
});
