/**
 * Воркер демо (SHELL-1): вся симуляция живёт здесь. Собирает мини-сцену
 * (`demo/sim.ts` — тот же headless-код, что и в однопоточной сборке),
 * Extractor рендера и `WorkerShell` — тикер, канал, ввод. Главный поток
 * (`main.ts`) не получает отсюда ничего, кроме handshake и конвертов тиков.
 */
import { shellPort, WorkerShell } from '@game-mvp/client';
import { Extractor, kindByTags } from '@game-mvp/render';
import type { SceneDef } from '@game-mvp/core';
import { PLAYER_ID, STATE_COMPONENTS, TICK_SECONDS, createDemoSimulation } from './sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const { sim, state, playerId, grid } = createDemoSimulation(sceneJson as unknown as SceneDef);

const extractor = new Extractor({
  // Ключи манифеста визуалов = теги prefab'ов сцены (ASSET-6). У Fireball
  // записи в манифесте нет НАМЕРЕННО: частицы отложены, снаряд — заглушка.
  kindOf: kindByTags(['Hero', 'Fireball']),
  terrainGrid: grid,
  // Доворот торса (REND-5) — по направлению каста: одно каноническое событие
  // сцены несёт и факт каста, и `dirX`/`dirY`.
  aimEvents: ['CastFireball'],
  // Компоненты-состояния, зеркалируемые в `EntityView.states` (CAM-6): по ним
  // диспетчер включает длящиеся эффекты манифеста. Список общий с главным
  // потоком (`sim.ts`) — порядок задаёт биты, и разойтись половинам нельзя.
  stateComponents: STATE_COMPONENTS,
});

const shell = new WorkerShell({
  port: shellPort(self as unknown as Worker),
  sim,
  state,
  tickSeconds: TICK_SECONDS,
  extractor,
  playerId: PLAYER_ID,
  // ID сущности героя нужен main-сборке (камера, прицел); оболочка extra не трактует.
  helloExtra: { hero: playerId },
});

shell.start();
