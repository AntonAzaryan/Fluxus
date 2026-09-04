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
 *
 * Собирается симуляция ПО КОНВЕРТУ (`DemoSoloInit`, design D4), а не на загрузке
 * модуля: документы контент-пака приезжают из раздачи оболочки (CONT-5), читает
 * их главный поток, и до конверта у соло-воркера нет ни сцены, ни чисел матча.
 */
import { shellPort, WorkerShell } from '@fluxus/client';
import { RingHistory, createInputLog, createRewindController } from '@fluxus/core';
import { ACTION_BITS, PLAYER_ID, TICK_SECONDS, createDemoSimulation } from './sim.js';
import { demoNavigationOf, demoRewindOf, demoScrubEveryOf, type DemoDocuments } from './match.js';
import { createDemoExtractor } from './extractor.js';
import { isDemoSoloInit } from './wiring.js';

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
};

/** Поднять соло-сборку по прочитанным документам: мир, история, оболочка. */
function start(documents: DemoDocuments): void {
  const scene = documents.scenes[documents.match.sceneRef];
  if (scene === undefined) {
    throw new Error(
      `демо: сцена "${documents.match.sceneRef}" не входит в контент-пак документа матча`,
    );
  }
  // Числа поиска пути — из документа матча (NTR-14): локальная сборка обязана
  // тикать тот же состав, что сетевая (SHELL-8).
  const { sim, state, playerId, grid } = createDemoSimulation(scene, {
    navigation: demoNavigationOf(documents.match),
  });

  // Машина состояний мира (WSM-1..6): без контроллера оболочка игнорирует
  // команды управления, и пауза из HUD (HUD-2, сценарий «Пауза из HUD») не
  // имела бы адресата.
  //
  // Профиль истории и exempt-список — из документа матча (`match.ts`): числа у
  // локальной сборки и у матча одни, иначе ульта отката отматывала бы на разную
  // глубину в зависимости от того, кто произвёл тик (SHELL-8). Умолчание рядом
  // стоит на случай матча без перемотки — оболочке нужен хоть какой-то провайдер
  // под паузу из HUD.
  const rewindOptions = demoRewindOf(documents.match);
  const history = new RingHistory({
    interval: rewindOptions?.interval ?? 30,
    capacity: rewindOptions?.capacity ?? 15,
  });
  // Глубина лога вводов привязана к глубине истории: реплей внутри `seekTo` идёт
  // по каноническим кадрам от ближайшего снапшота (REW-2), и умолчание, не
  // покрывающее буфер, молча оставило бы реплей без вводов.
  const inputs = createInputLog(history.depth + history.interval + 1);
  const rewind = createRewindController(sim, state, {
    history,
    inputs,
    ...(rewindOptions?.exempt !== undefined ? { exempt: rewindOptions.exempt } : {}),
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
    //
    // Каденс шага выводится из документа матча, а не берётся умолчанием: сервер
    // делает шаг раз в ЦИКЛ РАССЫЛКИ, то есть каждые `tickRate / snapshotRate`
    // тиков (REW-13), и совпадение этой величины с умолчанием оболочки — совпадение
    // чисел, а не правило. Разойдись они — ульта отматывала бы на разную глубину
    // за одно и то же удержание в зависимости от того, кто произвёл тик (SHELL-8).
    scrub: {
      button: ACTION_BITS.rewind,
      every: demoScrubEveryOf(documents.match),
      ...(rewindOptions?.step !== undefined ? { step: rewindOptions.step } : {}),
      ...(rewindOptions?.holdTimeoutTicks !== undefined
        ? { timeoutTicks: rewindOptions.holdTimeoutTicks }
        : {}),
    },
    // ID сущности героя нужен main-сборке (камера, прицел); оболочка extra не трактует.
    helloExtra: { hero: playerId },
  });

  shell.start();
}

scope.addEventListener('message', (event) => {
  if (!isDemoSoloInit(event.data)) return;
  start(event.data.documents);
});
