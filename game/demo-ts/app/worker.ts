/**
 * Воркер демо (SHELL-1): вся симуляция живёт здесь. Собирает мини-сцену
 * (`app/sim.ts` — тот же headless-код, что и в однопоточной сборке),
 * Extractor рендера и `WorkerShell` — тикер, канал, ввод. Главный поток
 * (`main.ts`) не получает отсюда ничего, кроме handshake и конвертов тиков.
 *
 * Режим — локальный, и объявлен он явно (`mode: 'local'`, SHELL-8): состояние
 * производит сама оболочка, перемотка исполняется здесь же. Сервера у демо нет
 * вовсе, и умолчанием этот выбор не достаётся — иначе один из двух режимов стал
 * бы неявной нормой.
 */
import { shellPort, WorkerShell } from '@game-mvp/client';
import {
  RingHistory,
  createInputLog,
  createRewindController,
  type SceneDef,
} from '@game-mvp/core';
import { ACTION_BITS, PLAYER_ID, TICK_SECONDS, createDemoSimulation } from './sim.js';
import { DEMO_REWIND } from './match.js';
import { createDemoExtractor } from './extractor.js';
import sceneJson from '../../../content/scenes/duel.scene.json';

const { sim, state, playerId, grid } = createDemoSimulation(sceneJson as unknown as SceneDef);

// Машина состояний мира (WSM-1..6): без контроллера оболочка игнорирует
// команды управления, и пауза из HUD (HUD-2, сценарий «Пауза из HUD») не
// имела бы адресата.
//
// Профиль истории и exempt-список — из документа матча (`match.ts`): числа у
// локальной сборки и у матча одни, иначе ульта отката отматывала бы на разную
// глубину в зависимости от того, кто произвёл тик (SHELL-8). Умолчание рядом
// стоит на случай матча без перемотки — оболочке нужен хоть какой-то провайдер
// под паузу из HUD.
const history = new RingHistory({
  interval: DEMO_REWIND?.interval ?? 30,
  capacity: DEMO_REWIND?.capacity ?? 15,
});
// Глубина лога вводов привязана к глубине истории: реплей внутри `seekTo` идёт
// по каноническим кадрам от ближайшего снапшота (REW-2), и умолчание, не
// покрывающее буфер, молча оставило бы реплей без вводов.
const inputs = createInputLog(history.depth + history.interval + 1);
const rewind = createRewindController(sim, state, {
  history,
  inputs,
  ...(DEMO_REWIND?.exempt !== undefined ? { exempt: DEMO_REWIND.exempt } : {}),
});

// Extractor — общий с сетевой сборкой (`extractor.ts`): presentation-состояние
// обязано выглядеть одинаково, кто бы ни произвёл тик (SHELL-8, REND-8).
const extractor = createDemoExtractor(grid);

const shell = new WorkerShell({
  mode: 'local',
  port: shellPort(self as unknown as Worker),
  sim,
  state,
  tickSeconds: TICK_SECONDS,
  extractor,
  playerId: PLAYER_ID,
  rewind,
  // Лог вводов и история — оболочке: канонический кадр собирает она, а
  // снапшоты снимаются только с живых тиков (SNAP-1).
  inputs,
  history,
  // Орган ведения скраба — тот же бит действия, которым ульта кастуется
  // (`ACTION_BITS.rewind`), и тот же номер, что у матча (`rewind.holdButton`).
  scrub: {
    button: ACTION_BITS.rewind,
    ...(DEMO_REWIND?.step !== undefined ? { step: DEMO_REWIND.step } : {}),
    ...(DEMO_REWIND?.holdTimeoutTicks !== undefined
      ? { timeoutTicks: DEMO_REWIND.holdTimeoutTicks }
      : {}),
  },
  // ID сущности героя нужен main-сборке (камера, прицел); оболочка extra не трактует.
  helloExtra: { hero: playerId },
});

shell.start();
