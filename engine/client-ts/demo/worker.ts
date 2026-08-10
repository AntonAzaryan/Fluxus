/**
 * Воркер демо (SHELL-1): вся симуляция живёт здесь. Собирает мини-сцену
 * (`demo/sim.ts` — тот же headless-код, что и в однопоточной сборке),
 * Extractor рендера и `WorkerShell` — тикер, канал, ввод. Главный поток
 * (`main.ts`) не получает отсюда ничего, кроме handshake и конвертов тиков.
 *
 * Режим — локальный, и объявлен он явно (`mode: 'local'`, SHELL-8): состояние
 * производит сама оболочка, перемотка исполняется здесь же. Сервера у демо нет
 * вовсе, и умолчанием этот выбор не достаётся — иначе один из двух режимов стал
 * бы неявной нормой.
 */
import { shellPort, WorkerShell } from '@game-mvp/client';
import { Extractor, kindByTags } from '@game-mvp/render';
import {
  RingHistory,
  createInputLog,
  createRewindController,
  type SceneDef,
} from '@game-mvp/core';
import { PLAYER_ID, STATE_COMPONENTS, TICK_SECONDS, createDemoSimulation } from './sim.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const { sim, state, playerId, grid } = createDemoSimulation(sceneJson as unknown as SceneDef);

// Машина состояний мира (WSM-1..6): без контроллера оболочка игнорирует
// команды управления, и пауза из HUD (HUD-2, сценарий «Пауза из HUD») не
// имела бы адресата. История и лог вводов — по образцу channel-тестов оболочки.
const history = new RingHistory({ interval: 1, capacity: 16 });
const rewind = createRewindController(sim, state, { history, inputs: createInputLog() });

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
  mode: 'local',
  port: shellPort(self as unknown as Worker),
  sim,
  state,
  tickSeconds: TICK_SECONDS,
  extractor,
  playerId: PLAYER_ID,
  rewind,
  // Снапшоты — только честных тиков (SNAP-1): реплей и пауза историю не пишут.
  observers: [
    {
      name: 'history',
      onTick: (result) => {
        if (result.mode === 'Running' && !result.isReplay) history.record(result.state);
      },
    },
  ],
  // ID сущности героя нужен main-сборке (камера, прицел); оболочка extra не трактует.
  helloExtra: { hero: playerId },
});

shell.start();
