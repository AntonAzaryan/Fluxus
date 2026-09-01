/**
 * Прогон сценария без рендера и сети (CLI-1): вход — один JSON-документ со
 * сценой, seed, начальной расстановкой и инпутами (CLI-2), выход — снапшот
 * состояния на каждый тик (CLI-3).
 *
 * Чистая функция, а не команда: golden-тесты (CLI-5) зовут её напрямую, а
 * `bin/sim.mjs` добавляет к ней только чтение файла и вывод в stdout.
 *
 * Фильтрации по видимости здесь нет и не будет (CLI-5): golden фиксирует
 * полный мир, `viewpoint = ALL` — FoW живёт в транспорте, а не в ядре.
 */
import { buildSimulation } from './build.js';
import { type LocomotionOptions } from '../systems/locomotion.js';
import { type PhysicsOptions } from '../systems/physics.js';
import { type NavigationOptions } from '../systems/nav/navigation.js';
import { type VisibilityOptions } from '../systems/visibility.js';
import { type ScenarioSpawn } from './placement.js';
import { type SceneDef } from './scene.js';
import { prettyJsonSerializer, snapshotToPlain, type PlainSnapshot } from './serialization.js';
import { tick } from './tick.js';
import type { DiagnosticsSink, InputFrame, SimulationState } from '../types.js';

export interface ScenarioDef {
  readonly name: string;
  readonly seed: number;
  readonly ticks: number;
  readonly scene: SceneDef;
  /**
   * Начальная расстановка прогона (SER-8): порядок записей задаёт выданные ID
   * (ID-2, DET-6). Расстановку сцены она не замещает — та применяется первой,
   * внутри `loadScene`, и участники прогона встают за ней.
   */
  readonly initial?: readonly ScenarioSpawn[];
  /** Канонические вводы тика (TICK-2); раскладываются по собственному полю `tick`. */
  readonly inputs?: readonly InputFrame[];
  /** Порядок игроков задаёт слоты (TICK-5); обязателен, если есть `inputs`. */
  readonly players?: readonly string[];
  /**
   * Включает физику (PHYS-4). Поле сценария, а не сцены: реализация — зависимость
   * сборки (DI-3, SER-7), в конфиге сцены её быть не должно.
   */
  readonly physics?: PhysicsOptions;
  /**
   * Включает нативный локомоушен (LOC-1). Поле сценария по тем же основаниям,
   * что и физика: какая реализация движет героя — зависимость сборки (SER-7),
   * а не данные сцены.
   */
  readonly locomotion?: LocomotionOptions;
  /**
   * Включает пересчёт видимости (FOW-4). Как и физика — поле сценария, а не
   * сцены: системе нужен raycast, то есть зависимость сборки (DI-3).
   */
  readonly visibility?: VisibilityOptions;
  /**
   * Включает поиск пути (NAV-1). Поле сценария по тем же основаниям, что физика
   * и локомоушен: бюджет раскрытий (NAV-5) и предел радиуса агента (TERR-7) —
   * зависимости сборки, а не данные сцены (SER-7), а сами карты производны от
   * ассета террейна (NAV-3).
   */
  readonly navigation?: NavigationOptions;
}

/**
 * Снапшот тика. События входят в него сами (SNAP-1): `emitEvent` — единственный
 * наблюдаемый выход системы, ничего не пишущей в мир, и без него golden не
 * заметил бы его пропажу.
 */
export type TickRecord = PlainSnapshot;

export interface RunOutput {
  readonly scenario: string;
  readonly seed: number;
  /**
   * Хеш `worldInit` (DET-1, CLI-3). Стоит перед `ticks`, потому что диагностика
   * требует сравнивать хеши раньше снапшотов: расхождение начальных данных
   * обязано быть видно в первых строках, до потиковой сверки.
   */
  readonly worldInitHash: string;
  /** Тик 0 — состояние после начальной расстановки, до первого `tick()`. */
  readonly ticks: readonly TickRecord[];
}

/**
 * Приёмник трейса (CLI-7). Необязателен: без него документ прогона совпадает с
 * тем, что был до появления диагностики, — эталоны от параметра не зависят.
 */
export function runScenario(def: ScenarioDef, diagnostics?: DiagnosticsSink): RunOutput {
  checkScenario(def);

  // Сборка мира — общий путь `buildSimulation` (DET-1): порядок регистрации
  // систем, расстановка и момент хеша `worldInit` там же, где их берёт матч
  // (NTR-5). Специфика сценария остаётся здесь — валидация документа выше и
  // прогон тиков ниже.
  const { sim, state, worldInitHash: hash } = buildSimulation(
    {
      scene: def.scene,
      seed: def.seed,
      ...(def.players !== undefined ? { players: def.players } : {}),
      ...(def.initial !== undefined ? { initial: def.initial } : {}),
      ...(def.physics !== undefined ? { physics: def.physics } : {}),
      ...(def.locomotion !== undefined ? { locomotion: def.locomotion } : {}),
      ...(def.visibility !== undefined ? { visibility: def.visibility } : {}),
      ...(def.navigation !== undefined ? { navigation: def.navigation } : {}),
    },
    {
      where: `сценарий "${def.name}"`,
      ...(diagnostics !== undefined ? { diagnostics } : {}),
    },
  );

  const byTick = inputsByTick(def.inputs);

  const ticks: TickRecord[] = [record(state)];
  for (let i = 0; i < def.ticks; i++) {
    tick(sim, state, byTick.get(state.tick + 1) ?? []);
    ticks.push(record(state));
  }

  return { scenario: def.name, seed: def.seed, worldInitHash: hash, ticks };
}

/**
 * Верхняя граница маски кнопок. Ширину `buttons` нормирует TICK-2 и она же —
 * единственный источник этого числа: здесь оно повторяется, как повторяет его
 * JSON-схема фрейма и проверка транспортной границы (`netcode-transport`
 * NTR-7), а не задаётся заново.
 */
const BUTTONS_MAX = 65535;

/**
 * Проверка документа сценария до сборки мира (CLI-2): опечатка обязана назвать
 * себя раньше, чем прогон дойдёт до первого тика.
 */
function checkScenario(def: ScenarioDef): void {
  if (typeof def.name !== 'string' || def.name === '') throw new Error('сценарий: "name" — непустая строка');
  if (!Number.isInteger(def.seed)) throw new Error(`сценарий "${def.name}": "seed" — целое число`);
  if (!Number.isInteger(def.ticks) || def.ticks < 0) {
    throw new Error(`сценарий "${def.name}": "ticks" — неотрицательное целое`);
  }
  if (def.inputs !== undefined && def.players === undefined) {
    throw new Error(`сценарий "${def.name}": есть "inputs", но нет "players" — слоты не определены (TICK-5)`);
  }
  checkButtons(def);
}

/**
 * Маска кнопок каждого фрейма — целое `0..65535` (TICK-2). Проверка живёт в
 * загрузчике, а не в схеме: схема опубликована, но на загрузке не применяется —
 * строгость документа несёт загрузчик (`ecs-foundation` ECS-5). Без неё бит
 * выше 15 лёг бы в мир целиком (поле компонента ввода — `i32`, TICK-4) и
 * `bitTest` по нему дал бы «нажато» — кнопку, которой не пережить круг через
 * транспорт: там ту же границу держит NTR-7. Молча усечённой маски не бывает
 * ни на одной из двух границ, и эта — вторая.
 */
function checkButtons(def: ScenarioDef): void {
  for (const frame of def.inputs ?? []) {
    const buttons = frame.buttons;
    if (Number.isInteger(buttons) && buttons >= 0 && buttons <= BUTTONS_MAX) continue;
    throw new Error(
      `сценарий "${def.name}": "buttons" фрейма игрока "${frame.playerId}" на тике ${frame.tick} — ` +
        `целое 0..${BUTTONS_MAX} (TICK-2), получено ${String(buttons)}`,
    );
  }
}

/** Кадры ввода по тикам (TICK-5); порядок внутри тика — порядок документа. */
function inputsByTick(inputs: readonly InputFrame[] | undefined): Map<number, InputFrame[]> {
  const byTick = new Map<number, InputFrame[]>();
  for (const frame of inputs ?? []) {
    const list = byTick.get(frame.tick);
    if (list) list.push(frame);
    else byTick.set(frame.tick, [frame]);
  }
  return byTick;
}

/** Байты для golden-файла и stdout: pretty JSON того же документа. */
export function runScenarioBytes(def: ScenarioDef, diagnostics?: DiagnosticsSink): Uint8Array {
  return prettyJsonSerializer.encode(runScenario(def, diagnostics));
}

function record(state: SimulationState): TickRecord {
  // Снапшот собирается из живого состояния без `takeSnapshot`: plain-форма и
  // так копирует всё в новые массивы, копия перед копией ничего не защищает.
  return snapshotToPlain({
    tick: state.tick,
    world: state.world,
    rng: state.rng.snapshot(),
    events: [...state.events],
    mode: state.mode,
  });
}
