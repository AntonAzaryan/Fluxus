/**
 * Персональная шкала времени сущности в кадре (REND-38): путь величины от
 * компонента мира `TimeScale` (`time-system` TIME-2) до поля `EntityView`.
 *
 * Здесь — только доставка: экстрактор читает компонент строго через
 * `hasComponent` и конвертирует Q16.16 во float на входной границе потока тиков
 * (REND-1), а `ViewBuffer` кладёт величину последнего доставленного тика в
 * запись. Что с ней делают потребители — клипы (`models`/`animation`) и
 * эмиттеры (`particles`) — проверяют их собственные сюиты.
 *
 * Ловушка, ради которой тест и написан, — НОЛЬ: тотальное чтение
 * несуществующего компонента дало бы ноль и заморозило бы всех, у кого шкалы
 * нет, а умолчание `getEffectiveDelta` — единица (TIME-3).
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type EntityId,
  type Scene,
  type Simulation,
} from '@fluxus/core';
import { Extractor, ViewBuffer, kindByTags } from '../src/index.js';

const F = (n: number): number => fixed.fromFloat(n);

/** Пол замедления поля босса демо-арены — та же величина, что в `duel.scene.json`. */
const SLOW = 0.2;

/**
 * Сцена с двумя сущностями: одна под шкалой, вторая без компонента вовсе.
 * Обе рисуются — «не рисуется» здесь не проверяется.
 */
function makeScene(): { scene: Scene; sim: Simulation } {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'TimeScale', fields: { value: 'fixed' }, defaults: { value: FIXED_ONE } },
    ],
    prefabs: [
      {
        name: 'Slowed',
        components: { Position: {}, TimeScale: { value: F(SLOW) } },
        tags: ['Runner'],
      },
      { name: 'Plain', components: { Position: {} }, tags: ['Runner'] },
    ],
  });
  const sim: Simulation = { systems: scene.systems, worldSeed: 7, math: mathApi };
  return { scene, sim };
}

describe('Extractor: колонка персонального темпа (REND-38)', () => {
  it('сущность со шкалой везёт её величину, сущность без компонента — единицу', () => {
    const { scene, sim } = makeScene();
    const slowed = worldInitSpawn(scene.world, 'Slowed', { Position: { x: F(1), y: F(1) } });
    const plain = worldInitSpawn(scene.world, 'Plain', { Position: { x: F(2), y: F(2) } });
    const state = initialState(scene.world, 7);
    const extractor = new Extractor({ kindOf: kindByTags(['Runner']) });

    const ext = extractor.extract(tick(sim, state));
    const at = (entity: EntityId): number => {
      for (let i = 0; i < ext.count; i++) if (ext.id[i] === entity) return ext.timeScale[i]!;
      throw new Error(`сущность ${String(entity)} не доехала в плоской форме`);
    };

    // Q16.16 → float считает экстрактор, глубже fixed-point не идёт (REND-1).
    expect(at(slowed)).toBeCloseTo(SLOW, 5);
    // РОВНО единица, а не «около нуля»: компонента нет — темп обычный (TIME-3).
    expect(at(plain)).toBe(1);
  });

  it('величина едет до записи буфера и меняется вместе с миром (REND-38)', () => {
    const { scene, sim } = makeScene();
    // Аура отпускает жертву: система сцены возвращает шкалу к единице на
    // третьем тике — запись буфера обязана пойти за миром, а не застыть на
    // первом доставленном значении.
    scene.systems.register({
      name: 'Release',
      order: 10,
      run(ctx) {
        if (ctx.tick !== 3) return;
        for (const entity of ctx.query({ all: ['TimeScale'] })) {
          ctx.commands.setField(entity, 'TimeScale', 'value', FIXED_ONE);
        }
      },
    });
    const slowed = worldInitSpawn(scene.world, 'Slowed', { Position: { x: F(1), y: F(1) } });
    const plain = worldInitSpawn(scene.world, 'Plain', { Position: { x: F(2), y: F(2) } });
    const state = initialState(scene.world, 7);
    const extractor = new Extractor({ kindOf: kindByTags(['Runner']) });
    const buffer = new ViewBuffer({ tickSeconds: 1 / 60, clock: () => 0 });
    const paceOf = (entity: EntityId): number => buffer.view.entities.get(entity)!.timeScale;

    buffer.apply(extractor.extract(tick(sim, state)));
    expect(paceOf(slowed)).toBeCloseTo(SLOW, 5);
    expect(paceOf(plain)).toBe(1);

    for (let step = 0; step < 3; step++) buffer.apply(extractor.extract(tick(sim, state)));
    expect(paceOf(slowed)).toBe(1);
    expect(paceOf(plain)).toBe(1);
  });
});
