/**
 * Буфер интерполяции (NET-3, NTR-10): порядок, отставание и то, что пропавшая
 * сущность — это «ушла в туман», а не смерть (NET-14).
 */
import { describe, expect, it } from 'vitest';
import { filterSnapshot, VIEWPOINT_ALL } from '@game-mvp/core';
import { InterpolationBuffer, vanishedEntities } from '../src/client/interpolation.js';
import { fogScene, duelConfig, harness, hello } from './fixtures.js';
import type { Snapshot } from '@game-mvp/core';

function fogMatch() {
  const config = duelConfig({
    scene: fogScene(),
    snapshotRate: 60,
    initial: [
      { prefab: 'Hero', overrides: { Visibility: { visibleTo: 3 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 3 }, Team: { id: 1 } },
      },
    ],
  });
  const { server } = harness(config);
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  server.drain();
  return server;
}

describe('порядок буфера', () => {
  it('снапшот, пришедший не по порядку, встаёт на своё место по тику', () => {
    const buffer = new InterpolationBuffer({ delayMs: 100 });
    const at = (tick: number): Snapshot => ({ tick } as Snapshot);

    buffer.push(at(4), 40);
    buffer.push(at(2), 20);
    buffer.push(at(6), 60);

    // Последним считается самый поздний по тику, а не по моменту прихода.
    expect(buffer.latest!.tick).toBe(6);
    expect(buffer.length).toBe(3);
  });

  it('до накопления буфера показывается самое раннее, без экстраполяции', () => {
    const buffer = new InterpolationBuffer({ delayMs: 100 });
    buffer.push({ tick: 1 } as Snapshot, 0);

    const sample = buffer.sample(10);
    expect(sample!.from.tick).toBe(1);
    expect(sample!.to.tick).toBe(1);
    expect(sample!.alpha).toBe(0);
  });

  it('отображаемый момент отстаёт от последнего пришедшего на величину буфера', () => {
    const buffer = new InterpolationBuffer({ delayMs: 100 });
    for (let i = 0; i <= 10; i++) buffer.push({ tick: i } as Snapshot, i * 33);

    const sample = buffer.sample(330)!;
    // Цель — 330 - 100 = 230 мс, то есть между снапшотами на 198 и 231.
    expect(sample.from.tick).toBe(6);
    expect(sample.to.tick).toBe(7);
    expect(sample.alpha).toBeGreaterThan(0);
    expect(sample.alpha).toBeLessThanOrEqual(1);
    expect(sample.lagMs).toBeCloseTo(100, 5);
  });

  it('обогнав буфер, показываем последнее известное и не экстраполируем (NET-2)', () => {
    const buffer = new InterpolationBuffer({ delayMs: 0 });
    buffer.push({ tick: 1 } as Snapshot, 0);
    buffer.push({ tick: 2 } as Snapshot, 10);

    const sample = buffer.sample(10_000)!;
    expect(sample.from.tick).toBe(2);
    expect(sample.to.tick).toBe(2);
    expect(sample.alpha).toBe(0);
  });
});

describe('исчезновение сущности', () => {
  it('пропавшая из снапшота — это список на гашение, а не смерть (NET-14)', () => {
    const server = fogMatch();
    server.advance();

    const full = server.snapshot(VIEWPOINT_ALL);
    // Снапшот глазами команды 0 после того, как противник ушёл в туман:
    // моделируем это фильтром по команде, которой он не виден.
    const narrowed = filterSnapshot(full, 5);

    const gone = vanishedEntities(full, narrowed);
    expect(gone).toHaveLength(2);
    // Событий смерти при этом нет — клиент обязан различать эти случаи.
    expect(narrowed.events.some((event) => event.type === 'EntityDied')).toBe(false);
  });

  it('ничего не пропало — пустой список', () => {
    const server = fogMatch();
    server.advance();

    const full = server.snapshot(VIEWPOINT_ALL);
    expect(vanishedEntities(full, full)).toEqual([]);
  });
});
