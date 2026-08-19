/**
 * Сборка симуляции до первого тика (DET-1) — один путь на все документы
 * прогона: сценарий CLI (CLI-2) и конфиг матча (NTR-5, NTR-6).
 *
 * Один он не ради экономии строк, а по существу. Порядок регистрации систем и
 * момент, в который считается хеш `worldInit`, нормативны: по этому хешу
 * сверяются клиент и сервер (NTR-5), а прогон записанного матча через
 * `runScenario` (NTR-8, CLI-10) имеет смысл ровно постольку, поскольку обе
 * стороны собирают мир одинаково. Две похожие сборки, разошедшиеся в порядке
 * спавна или в валидации расстановки, дали бы расхождение хешей на честных
 * данных — то есть отказ входа там, где входить можно.
 *
 * Что различается между документами, приходит параметрами: состав нативных
 * систем — зависимости сборки (DI-3), которых в конфиге сцены нет и не будет
 * (SER-7), и контекст сообщений валидации (`where`). Всё остальное — сцена,
 * расстановка, seed — общее.
 *
 * Мутирующей поверхности ядра это не расширяет (TICK-3, исключение
 * `worldInit`): функция не принимает чужой мир, а поднимает свой и отдаёт его
 * уже внутри `SimulationState` — до первого `tick()`, ровно в тот момент,
 * который DET-1 называет `worldInit`.
 */
import { InputSystem, inputTargetDeclared } from '../systems/inputSystem.js';
import { LocomotionSystem, type LocomotionOptions } from '../systems/locomotion.js';
import { mathApi } from '../math/mathApi.js';
import {
  createPhysicsApi,
  PhysicsSystem,
  PhysicsWorld,
  staticsFromTerrain,
  type PhysicsOptions,
} from '../systems/physics.js';
import { requireModifierList } from '../systems/modifiers.js';
import { VisibilitySystem, VISION_MODIFIER_COMPONENT, type VisibilityOptions } from '../systems/visibility.js';
import { applyPlacement, type ScenarioSpawn } from './placement.js';
import { loadScene, type SceneDef } from './scene.js';
import { initialState, type Simulation } from './tick.js';
import { worldInitHash } from './worldInit.js';
import type { DiagnosticsSink, PhysicsApi, SimulationState } from '../types.js';

/**
 * Общая часть документа прогона: то, из чего поднимается мир. Поля-опции
 * (`physics`, `locomotion`, `visibility`) — зависимости сборки, а не данные
 * сцены (DI-3, SER-7); их наличие и включает соответствующую нативную систему.
 */
export interface SimulationBuildDef {
  readonly scene: SceneDef;
  readonly seed: number;
  /**
   * Порядок игроков задаёт слоты (TICK-5). Необязателен: прогон сценария без
   * инпутов обходится без `InputSystem` (CLI-2), матч — нет (NTR-5), и
   * обязательность поля проверяет тот, кто документ читает.
   */
  readonly players?: readonly string[];
  /**
   * Расстановка документа прогона (SER-8). Расстановку конфига сцены она не
   * замещает: та применяется первой, внутри `loadScene`, — расстановки
   * складываются, а порядок «носители → сцена → документ прогона» задаёт
   * выданные ID (ID-2, DET-6), то есть хеш `worldInit`.
   */
  readonly initial?: readonly ScenarioSpawn[];
  readonly physics?: PhysicsOptions;
  readonly locomotion?: LocomotionOptions;
  readonly visibility?: VisibilityOptions;
}

export interface SimulationBuildOptions {
  /**
   * Контекст сообщений валидации расстановки (SER-8): `сценарий "duel"`,
   * `конфиг матча`. Номер записи добавит `applyPlacement` — по одному имени
   * prefab'а автор документа не найдёт, какую из десяти записей он сломал.
   */
  readonly where: string;
  /**
   * Приёмник трейса (CLI-7, DIAG-1). Необязателен: без него собранная
   * `Simulation` совпадает с той, что была до появления диагностики.
   */
  readonly diagnostics?: DiagnosticsSink;
}

export interface BuiltSimulation {
  readonly sim: Simulation;
  readonly state: SimulationState;
  /** Считается после расстановки и до первого тика — момент `worldInit` (DET-1). */
  readonly worldInitHash: string;
}

export function buildSimulation(
  def: SimulationBuildDef,
  options: SimulationBuildOptions,
): BuiltSimulation {
  // Системы, включаемые составом сцены (в том числе `ArenaSystem`), регистрирует
  // сам загрузчик (SER-7); здесь — только те, которым нужна зависимость сборки.
  const { world, systems, terrain, arena, modifiers, abilities } = loadScene(def.scene);
  // Раскладка точки прицела (TICK-2) включается объявлением полей у компонента
  // ввода сцены, а не флагом документа прогона: точка нужна ровно той сцене,
  // чьи способности целятся ею (ABIL-5), и сцена говорит об этом составом
  // компонента — тем же способом, каким она говорит обо всём остальном.
  if (def.players !== undefined) {
    systems.register(new InputSystem({ players: def.players, target: inputTargetDeclared(world) }));
  }
  if (def.locomotion !== undefined) systems.register(new LocomotionSystem(def.locomotion));

  // Статика обрывов строится из террейна до расстановки: она иммутабельна и в
  // снапшот не входит (TERR-5, TERR-6).
  let physics: PhysicsApi | undefined;
  if (def.physics !== undefined) {
    const statics = terrain === undefined ? [] : staticsFromTerrain(terrain.grid);
    const physicsWorld = new PhysicsWorld(statics, terrain?.grid.tileSize);
    systems.register(new PhysicsSystem(physicsWorld, def.physics));
    physics = createPhysicsApi(world, physicsWorld, def.physics);
  }

  // Видимость считается по финальным позициям тика, поэтому регистрируется
  // после физики (FOW-6).
  if (def.visibility !== undefined) {
    systems.register(new VisibilitySystem(requireModifierList(modifiers, VISION_MODIFIER_COMPONENT)));
  }

  // Расстановка документа прогона — после расстановки сцены, которую применил
  // `loadScene` (SER-8): сцена описывает содержимое арены, документ — участников
  // этого прогона, и ID выданы в этом порядке.
  applyPlacement(world, def.initial, options.where);

  const state = initialState(world, def.seed);
  // Считается здесь и только здесь: после начальной расстановки и до первого
  // тика — ровно тот момент, который DET-1 называет `worldInit`.
  const worldInitHashValue = worldInitHash({
    world,
    mode: state.mode,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
  });
  const sim: Simulation = {
    systems,
    worldSeed: def.seed,
    math: mathApi,
    modifiers,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(abilities !== undefined ? { abilities } : {}),
    ...(physics !== undefined ? { physics } : {}),
    ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
  };

  return { sim, state, worldInitHash: worldInitHashValue };
}
