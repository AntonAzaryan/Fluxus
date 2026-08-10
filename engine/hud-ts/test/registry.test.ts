/**
 * Реестры видов, селекторов и действий и резолв композиции (задача 2.2,
 * образец — `systems/registry.ts` ядра): повторная регистрация и неизвестное
 * имя падают ошибкой, называющей имя.
 */
import { describe, expect, it } from 'vitest';
import { HudRegistry, resolveComposition, type HudComposition } from '../src/index.js';
import { captureKind, type CaptureWidget } from './support/hud.js';

function filledRegistry(created: CaptureWidget[] = []): HudRegistry {
  const registry = new HudRegistry();
  registry.registerWidget(captureKind('statusPanel', created));
  registry.registerSelector('tickNumber', (state) => state.tick);
  registry.registerAction('jumpButton', { target: 'world', action: 'jump' });
  return registry;
}

describe('HudRegistry', () => {
  it('повторная регистрация имени — ошибка с именем', () => {
    const registry = filledRegistry();
    expect(() => { registry.registerWidget(captureKind('statusPanel', [])); }).toThrow('statusPanel');
    expect(() => { registry.registerSelector('tickNumber', () => 0); }).toThrow('tickNumber');
    expect(() => { registry.registerAction('jumpButton', { target: 'world', action: 'jump' }); }).toThrow(
      'jumpButton',
    );
  });

  it('неизвестное имя — ошибка с именем', () => {
    const registry = new HudRegistry();
    expect(() => registry.widgetKind('minimap')).toThrow('minimap');
    expect(() => registry.selector('heroHp')).toThrow('heroHp');
    expect(() => registry.action('castButton')).toThrow('castButton');
  });
});

describe('резолв композиции против реестров (HUD-4)', () => {
  const entry = (over: Partial<HudComposition['entries'][number]>): HudComposition => ({
    entries: [{ widget: 'statusPanel', zone: 'top-left', ...over }],
  });

  it('успешный резолв возвращает план: вид, зону, селекторы и действия', () => {
    const registry = filledRegistry();
    const plan = resolveComposition(
      registry,
      entry({ bindings: { tick: 'tickNumber' }, actions: { jump: 'jumpButton' } }),
    );
    expect(plan.entries).toHaveLength(1);
    const resolved = plan.entries[0]!;
    expect(resolved.kind.name).toBe('statusPanel');
    expect(resolved.zone).toBe('top-left');
    expect(resolved.bindings).toEqual([
      { slot: 'tick', name: 'tickNumber', selector: expect.any(Function) as unknown },
    ]);
    expect(resolved.actions[0]!.decl).toEqual({ target: 'world', action: 'jump' });
  });

  it('неизвестный вид виджета назван в ошибке', () => {
    expect(() =>
      resolveComposition(filledRegistry(), { entries: [{ widget: 'minimap', zone: 'center' }] }),
    ).toThrow('неизвестный вид виджета "minimap"');
  });

  it('неизвестный селектор назван вместе со слотом', () => {
    expect(() =>
      resolveComposition(filledRegistry(), entry({ bindings: { hp: 'heroHp' } })),
    ).toThrow('неизвестный селектор "heroHp" в слоте "hp"');
  });

  it('неизвестное действие названо вместе со слотом', () => {
    expect(() =>
      resolveComposition(filledRegistry(), entry({ actions: { cast: 'castButton' } })),
    ).toThrow('неизвестное действие "castButton" в слоте "cast"');
  });

  it('неизвестная зона названа в ошибке (защита будущего JSON-источника)', () => {
    const composition = {
      entries: [{ widget: 'statusPanel', zone: 'middle-ish' }],
    } as unknown as HudComposition;
    expect(() => resolveComposition(filledRegistry(), composition)).toThrow(
      'неизвестная зона "middle-ish"',
    );
  });
});
