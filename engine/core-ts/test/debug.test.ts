import { afterEach, describe, expect, it, vi } from 'vitest';
import { assert, assertInvariant, setAssertSink } from '../src/debug.js';

afterEach(() => {
  setAssertSink(() => {}); // не протекать sink между тестами
});

describe('assert (FP-4): мягкая диагностика, не часть симуляции', () => {
  it('условие истинно — не зовёт sink', () => {
    const sink = vi.fn();
    setAssertSink(sink);
    assert(true, 'unreachable');
    expect(sink).not.toHaveBeenCalled();
  });

  it('условие ложно — зовёт sink с сообщением, НЕ бросает исключение', () => {
    const sink = vi.fn();
    setAssertSink(sink);
    expect(() => assert(false, 'что-то не так')).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toContain('что-то не так');
  });

  it('без подключённого sink (дефолт no-op) — молчаливо не бросает', () => {
    expect(() => assert(false, 'без sink')).not.toThrow();
  });

  it('возвращаемого значения нет — assert не может повлиять на результат вызывающей операции', () => {
    // assert — void; сам факт сигнатуры (condition, message) => void не оставляет
    // канала, которым диагностика могла бы просочиться в результат расчёта.
    const result: void = assert(false, 'x');
    expect(result).toBeUndefined();
  });
});

describe('assertInvariant (FP-4/ID-1): жёсткая граница, бросает в обоих режимах', () => {
  it('условие истинно — не бросает', () => {
    expect(() => assertInvariant(true, 'unreachable')).not.toThrow();
  });

  it('условие ложно — бросает исключение с сообщением', () => {
    expect(() => assertInvariant(false, 'граница нарушена')).toThrow(/граница нарушена/);
  });

  it('sink не участвует в assertInvariant', () => {
    const sink = vi.fn();
    setAssertSink(sink);
    expect(() => assertInvariant(false, 'x')).toThrow();
    expect(sink).not.toHaveBeenCalled();
  });

  it('бросает и в release-сборке (DEBUG=false) — не зависит от режима', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    try {
      const release = await import('../src/debug.js');
      expect(release.DEBUG).toBe(false);
      expect(() => release.assertInvariant(false, 'жёсткая граница')).toThrow(/жёсткая граница/);
      expect(() => release.assert(false, 'мягкая диагностика')).not.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
      vi.resetModules();
    }
  });
});
