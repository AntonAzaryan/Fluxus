/**
 * Extractor демо — один на обе сборки (SHELL-8): и на одиночную симуляцию
 * (`worker.ts`), и на тонкого клиента матча (`netClient.ts`).
 *
 * Общий он по той же причине, по какой общий конфиг матча: presentation-состояние
 * обязано выглядеть одинаково независимо от того, кто произвёл тик, — иначе
 * подсистема рендера различала бы режимы, чего REND-8 не допускает.
 */
import type { TerrainGrid } from '@game-mvp/core';
import { Extractor, kindByTags, type StatSource } from '@game-mvp/render';
import { COOLDOWN_ABILITIES, FIREBALL_LIFETIME_TICKS, STATE_COMPONENTS, STATS } from './sim.js';

/**
 * Конфигурация доставляемых статов демо (HUD-8): «имя доставки → компонент и
 * поле мира». Это ДАННЫЕ сборки, а не код кодека: новый стат — запись в этом
 * списке плюс биндинг в композиции HUD, и ни экстрактор, ни кодек, ни виджет
 * при этом не правятся.
 *
 * Компоненты здоровья, счёта и кулдаунов сцена демо пока не содержит — их
 * добавит геймплейная фаза. Запись без компонента-источника молча не едет
 * (`hasComponent` мира отвечает «нет»), и виджет показывает пустое состояние —
 * ровно тот сценарий, который HUD-8 и описывает.
 */
export const DEMO_STATS: readonly StatSource[] = Object.freeze([
  { name: STATS.slot, component: 'Player', field: 'slot' },
  { name: STATS.hp, component: 'Health', field: 'hp' },
  { name: STATS.hpMax, component: 'Health', field: 'hpMax' },
  { name: STATS.deaths, component: 'Score', field: 'deaths' },
  ...COOLDOWN_ABILITIES.flatMap((ability) => [
    { name: STATS.cooldown(ability), component: 'Cooldowns', field: ability },
    { name: STATS.cooldownMax(ability), component: 'Cooldowns', field: `${ability}Max` },
  ]),
]);

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
    // Геймплейные статы доставки (HUD-8): имена уезжают один раз в handshake,
    // значения — разреженными парами в кадре.
    stats: DEMO_STATS,
  });
}
