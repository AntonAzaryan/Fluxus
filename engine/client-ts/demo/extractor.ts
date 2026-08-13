/**
 * Extractor демо — один на обе сборки (SHELL-8): и на одиночную симуляцию
 * (`worker.ts`), и на тонкого клиента матча (`netClient.ts`).
 *
 * Общий он по той же причине, по какой общий конфиг матча: presentation-состояние
 * обязано выглядеть одинаково независимо от того, кто произвёл тик, — иначе
 * подсистема рендера различала бы режимы, чего REND-8 не допускает.
 */
import type { TerrainGrid } from '@game-mvp/core';
import { Extractor, kindByTags } from '@game-mvp/render';
import { FIREBALL_LIFETIME_TICKS, STATE_COMPONENTS } from './sim.js';

export function createDemoExtractor(grid: TerrainGrid | undefined): Extractor {
  return new Extractor({
    // Ключи манифеста визуалов = теги prefab'ов сцены (ASSET-6). Снаряд
    // рисуется записью эффекта, а не моделью, — ключ ему нужен тот же.
    kindOf: kindByTags(['Hero', 'Fireball']),
    ...(grid !== undefined ? { terrainGrid: grid } : {}),
    // Доворот торса (REND-5) — по направлению каста: одно каноническое событие
    // сцены несёт и факт каста, и `dirX`/`dirY`.
    aimEvents: ['CastFireball'],
    // Компоненты-состояния, зеркалируемые в `EntityView.states` (CAM-6): список
    // общий с главным потоком (`sim.ts`) — порядок задаёт биты.
    stateComponents: STATE_COMPONENTS,
    // Фаза полёта снаряда (REND-12): `Lifetime.ticks` сцены считает оставшиеся
    // тики вниз, полное число — константа сборки. Рендер фазу не вычисляет —
    // он получает её плоской формой и по ней рисует низкую дугу (SHELL-2).
    flight: { component: 'Lifetime', field: 'ticks', total: FIREBALL_LIFETIME_TICKS },
  });
}
