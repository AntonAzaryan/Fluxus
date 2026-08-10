/**
 * Композиция — JSON-сериализуемое значение (HUD-4, задача 2.1): «шов под
 * data-driven» — проверяемое свойство, а не намерение. Round-trip через
 * JSON.stringify/parse обязан вернуть глубоко равное значение.
 */
import { describe, expect, it } from 'vitest';
import type { HudComposition } from '../src/index.js';

/** Представительная композиция: параметры с вложенностью, биндинги, действия. */
const representative: HudComposition = {
  entries: [
    {
      widget: 'statusPanel',
      zone: 'top-left',
      params: { compact: false, title: 'Матч' },
      bindings: { tick: 'tickNumber', mode: 'worldMode' },
    },
    {
      widget: 'heroActions',
      zone: 'bottom',
      params: {
        slots: ['cast', 'dodge', 'jump'],
        cooldownRing: { width: 3, color: 'accent' },
      },
      bindings: { hero: 'heroStatus' },
      actions: { cast: 'castButton', dodge: 'dodgeButton', jump: 'jumpButton' },
    },
    {
      widget: 'minimap',
      zone: 'bottom-right',
      params: {
        size: 192,
        markers: [
          { kind: 'hero', shape: 'icon', priority: 10 },
          { kind: 'creep', shape: 'dot', priority: 1 },
        ],
        unknownKindPolicy: null,
      },
      actions: { pan: 'minimapPan' },
    },
  ],
};

describe('HudComposition — данные, а не код (HUD-4)', () => {
  it('переживает round-trip сериализации без потерь', () => {
    const restored: unknown = JSON.parse(JSON.stringify(representative));
    expect(restored).toEqual(representative);
  });

  it('несериализуемое значение в параметрах не проходит типы', () => {
    const bad: HudComposition = {
      entries: [
        {
          widget: 'statusPanel',
          zone: 'top-left',
          // @ts-expect-error — функция не JSON-значение: биндинги-замыкания в композиции запрещены (HUD-4)
          params: { onClick: () => 0 },
        },
      ],
    };
    expect(bad.entries).toHaveLength(1);
  });
});
