/**
 * @contribution Встроенный runner превью (ED-9) — часть вклада области сцены,
 * а не каркаса: что прогонять и откуда взять сцену, знает вклад (ED-25).
 *
 * ED-9 задаёт сборку целиком: «текущее состояние документов сцены (включая
 * несохранённые правки) собирается и прогоняется через ядро ТОЙ ЖЕ клиентской
 * оболочкой, что у игрового клиента (`client-shell` SHELL-1..7) — ядро в
 * воркере, рендер в главном потоке. Собственный цикл симуляции редактора MUST
 * NOT существовать». Отсюда всё устройство этого модуля:
 *
 * - тикает `WorkerShell` в воркере, и он же владеет миром (SHELL-1). Тика в
 *   главном потоке нет ни одного — ни здесь, ни во вьюпорте;
 * - в главный поток приезжает `RemoteHost` (SHELL-2), и публикует он в ту же
 *   `PresentationStage`, что документный источник вьюпорта. Продюсеры
 *   взаимоисключающи (REND-11): вход в превью гасит документные инстансы, а
 *   выход — инстансы прогона, и объект не может оказаться в кадре дважды;
 * - кадр прогона крутит цикл вьюпорта (`attachProducer`), а не второй свой.
 *
 * ## Откуда берётся сцена прогона
 *
 * Из сессии, а не с диска: значение открытого документа и есть текущее
 * состояние, включая несохранённые правки (ED-26 прямо запрещает требовать
 * сохранения). Конфиг сцены — валидный для ядра `SceneDef` (ED-3), поэтому
 * пересборки формата не требуется: он уезжает в воркер как есть и там же
 * поднимается `loadScene`.
 *
 * ## Чего у прогона нет
 *
 * - Ввода игрока: слот локального игрока не назван, и `WorkerShell` тикает без
 *   `InputFrame` вовсе. Это же и делает ED-13 выполнимым не обещанием, а
 *   конструкцией: обратного канала ввода у превью нет, посылать камере в него
 *   нечего, и прогон с движениями камеры совпадает с прогоном без них.
 * - Сети: превью локально, `netcode` в нём не участвует.
 * - Записи куда бы то ни было: мир прогона живёт в воркере, документы — в
 *   сессии главного потока, и канала от первого ко вторым не существует
 *   (SHELL-6 знает только ввод и команды WSM). «Превью MUST NOT записывать
 *   что-либо в документы и дерево контента» выполняется отсутствием пути.
 *
 * ## Что собирает воркер сверх `loadScene`
 *
 * `loadScene` регистрирует нативные системы, включаемые составом сцены, кроме
 * тех, которым нужна зависимость сборки (DI-3). Из них превью подаёт физику:
 * без неё картинка прогона расходилась бы с игровой на первом же обрыве, а
 * ED-9 обещает автору проверку способности, а не похожую на неё. Ввод и
 * локомоушен — раскладка кнопок конкретной игры (LOC-1), и подать их нечем:
 * документ сцены о них не говорит.
 */
import {
  PhysicsSystem,
  PhysicsWorld,
  initialState,
  loadScene,
  mathApi,
  staticsFromTerrain,
  type SceneDef,
  type Simulation,
  type SimulationState,
} from '@game-mvp/core';
import { Extractor, kindByTags } from '@game-mvp/render';
import { RemoteHost, WorkerShell, shellPort, type ShellPort } from '@game-mvp/client';
import type { PreviewRun, PreviewSource } from '../frame/preview.js';
import type { SceneStage } from './sceneStage.js';

/**
 * Длительность тика прогона. Документ сцены её не несёт (SER-7) — её несёт
 * документ прогона (сценарий CLI-2, конфиг матча NTR-5), которого у редактора
 * пока нет, — поэтому здесь она настройка runner'а, а не выдумка о сцене.
 */
export const PREVIEW_TICK_SECONDS = 1 / 60;

/**
 * Зерно мира прогона. По той же причине константа: сцена зерна не хранит, а
 * два прогона одних и тех же документов обязаны совпадать (DET-1) — иначе
 * «проверил правку» означало бы «посмотрел один из вариантов».
 */
export const PREVIEW_WORLD_SEED = 20260805;

/** Тег сообщения, которым главный поток отдаёт воркеру сцену прогона. */
export const PREVIEW_SCENE_MESSAGE = 'preview-scene';

/**
 * Сцена прогона на пути в воркер. Отдельным сообщением, а не аргументом
 * сборки: воркер поднимается пустым и ждёт сцену, потому что сцена приходит из
 * несохранённых документов главного потока (ED-9), а не из дерева контента.
 * Протокол оболочки этим не расширяется — сообщение чужого тега и `WorkerShell`,
 * и `RemoteHost` пропускают мимо.
 */
export interface PreviewSceneMessage {
  readonly t: typeof PREVIEW_SCENE_MESSAGE;
  /** Конфиг сцены как его видит сессия — валидный для ядра JSON (ED-3). */
  readonly def: SceneDef;
  /** Ключи манифеста визуалов: по ним `Extractor` называет визуальный тип (ASSET-6). */
  readonly kinds: readonly string[];
  readonly tickSeconds: number;
  readonly seed: number;
}

export function isPreviewSceneMessage(message: unknown): message is PreviewSceneMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { t?: unknown }).t === PREVIEW_SCENE_MESSAGE
  );
}

/** Симуляция прогона в воркере: оболочка и состояние, которым она владеет. */
export interface PreviewSimulation {
  readonly shell: WorkerShell;
  readonly state: SimulationState;
}

/**
 * Воркерная половина прогона (SHELL-1): поднимает мир по присланной сцене и
 * отдаёт оболочку незапущенной. Пуск — за вызывающим: в воркере это тикер, в
 * headless-прогоне тестов — ручной `stepTick` без таймеров.
 */
export function startPreviewSimulation(
  port: ShellPort,
  message: PreviewSceneMessage,
): PreviewSimulation {
  const scene = loadScene(message.def);
  // Физика — зависимость сборки, а не часть сцены (DI-3): статика обрывов
  // выводится ядром из той же сетки, из которой рендер строит стенки (TERR-5).
  if (scene.terrain !== undefined) {
    const grid = scene.terrain.grid;
    scene.systems.register(
      new PhysicsSystem(new PhysicsWorld(staticsFromTerrain(grid), grid.tileSize)),
    );
  }
  const state = initialState(scene.world, message.seed);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: message.seed,
    math: mathApi,
    modifiers: scene.modifiers,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
    ...(scene.arena !== undefined ? { arena: scene.arena } : {}),
  };
  const extractor = new Extractor({
    kindOf: kindByTags(message.kinds),
    ...(scene.terrain !== undefined ? { terrainGrid: scene.terrain.grid } : {}),
  });
  // Слота локального игрока нет намеренно: прогон идёт без ввода (см. шапку).
  const shell = new WorkerShell({
    port,
    sim,
    state,
    tickSeconds: message.tickSeconds,
    extractor,
  });
  return { shell, state };
}

/**
 * Вторая сторона канала оболочки (SHELL-3) — то единственное, что у превью
 * зависит от среды. В вебе это dedicated Worker; тест подставляет пару
 * синхронных портов, потому что настоящего воркера в headless-прогоне нет, а
 * проверять надо ЧТО пересекает границу, а не чем оно её пересекает.
 */
export interface PreviewBackend {
  readonly port: ShellPort;
  /**
   * Пуск второй стороны. Зовётся ПОСЛЕ подключения главного потока: handshake
   * (SHELL-5) уходит первым же сообщением, и отправленный раньше он достался бы
   * порту, которого ещё никто не слушает.
   */
  start(): void;
  /** Снос: воркер живёт ровно столько, сколько прогон. */
  dispose(): void;
}

export type PreviewBackendFactory = (message: PreviewSceneMessage) => PreviewBackend;

/** Воркер веба: тот же механизм, что у игрового клиента (SHELL-1). */
export function workerPreviewBackend(message: PreviewSceneMessage): PreviewBackend {
  const worker = new Worker(new URL('./previewWorker.ts', import.meta.url), { type: 'module' });
  const port = shellPort(worker);
  return {
    port,
    start: () => {
      port.post(message);
    },
    dispose: () => {
      worker.terminate();
    },
  };
}

/** Что прогону нужно от области сцены; всё — функциями, потому что всё меняется. */
export interface ScenePreviewHooks {
  /**
   * Конфиг сцены, как его видит сессия сейчас, — вместе с несохранёнными
   * правками (ED-9); `null` — проект не открыт, и прогонять нечего.
   */
  scene(): SceneDef | null;
  /** Визуальные типы манифеста (ASSET-6) — таблица kind'ов прогона. */
  kinds(): readonly string[];
  /** Кадр вьюпорта; `null` — в этой среде рисовать нечем, и показывать прогон негде. */
  stage(): SceneStage | null;
  /**
   * Вход в превью, до первого тика. Здесь область бросает незакрытое
   * взаимодействие (ED-9, ED-18): перетаскивание или мазок, оставшийся
   * открытым, запрещает сессии и следующую операцию, и undo — то есть
   * переживает превью дефектом.
   */
  enter(): void;
  /**
   * Выход из превью, после сноса прогона. Здесь область возвращает вьюпорт
   * документам — переподаёт набор инстансов и сетку (REND-11, REND-14).
   * Отдельным вызовом, а не «сессия сама заметит»: документы за прогон не
   * менялись, и по совпадению значений не доехало бы ничего — включая пол,
   * выбитый тиками прогона.
   */
  leave(): void;
  /** Чем поднимается вторая сторона канала; по умолчанию — воркер веба. */
  readonly backend?: PreviewBackendFactory;
}

/**
 * Прогон текущих документов (ED-9) как вклад в каркас: каркас спрашивает
 * `ready` и зовёт `start`, не зная ни одного доменного имени (ED-25).
 */
export function createScenePreview(hooks: ScenePreviewHooks): PreviewSource {
  return {
    ready: () => hooks.scene() !== null && hooks.stage() !== null,
    start(): PreviewRun {
      const def = hooks.scene();
      const stage = hooks.stage();
      if (def === null || stage === null) {
        throw new Error('превью: прогонять нечего — проект не открыт или кадра нет');
      }
      // Годность конфига спрашивается у ядра ДО всего остального: негодный оно
      // отвергает на загрузке (SER-7), и причина обязана дойти до автора
      // (ED-8). Не вторая реализация проверки, а тот же её вызов (ED-1):
      // внутри воркера исключение осталось бы там, и автор увидел бы пустой
      // кадр вместо причины. Отказ на этом шаге не трогает область вовсе —
      // ни режима, ни начатого взаимодействия он не меняет.
      loadScene(def);

      const message: PreviewSceneMessage = {
        t: PREVIEW_SCENE_MESSAGE,
        def,
        kinds: hooks.kinds(),
        tickSeconds: PREVIEW_TICK_SECONDS,
        seed: PREVIEW_WORLD_SEED,
      };

      let host: RemoteHost | null = null;
      let backend: PreviewBackend | undefined;
      let detach: () => void = () => undefined;
      // Под откатом — ВСЁ, начиная со входа в превью: любая строка ниже может
      // сорваться, а область, объявившая вход и не получившая выхода, осталась
      // бы в превью, которого нет, — с запертыми авторингом и undo (ED-9, ED-18).
      try {
        // Вход объявляется до запуска: авторинг в превью недоступен (ED-9), а
        // брошенная открытой транзакция была бы авторингом, пережившим запрет.
        hooks.enter();
        // Сцена подсистем — та же, что у вьюпорта (REND-11): подсистемы не
        // различают продюсеров, и второй сцены превью не заводит.
        const remote = new RemoteHost(stage.context, { stage: stage.presentation });
        host = remote;
        backend = (hooks.backend ?? workerPreviewBackend)(message);
        remote.connect(backend.port);
        detach = stage.attachProducer((now) => {
          remote.frame(now);
        });
        backend.start();
      } catch (error) {
        // Наполовину поднятый прогон не остаётся: иначе воркер пережил бы
        // отказ, а область — осталась бы в превью, которого нет.
        detach();
        if (host !== null) stage.presentation.detach(host);
        backend?.dispose();
        hooks.leave();
        throw error;
      }
      const started = backend;
      const running = host;

      let stopped = false;
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          try {
            detach();
            // Продюсер уходит, не передавая состояние: его инстансы гасятся
            // штатным правилом REND-3, сцена остаётся ничьей до первой подачи
            // документов (REND-11).
            stage.presentation.detach(running);
            started.dispose();
          } finally {
            // Возврат вьюпорта документам — в `finally`, а не последней строкой:
            // сорвавшийся снос прогона не имеет права оставить кадр в превью
            // навсегда. Сцена в этот момент уже ничья (REND-11), и не переподать
            // документы значило бы показывать автору мир прогона в режиме
            // правки, без единого способа его оттуда убрать (ED-9).
            hooks.leave();
          }
        },
      };
    },
  };
}
