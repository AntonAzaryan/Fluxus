/**
 * Подъём мира матча — общий для сервера и клиента.
 *
 * Общий он не ради экономии строк, а по существу: сверка хешей `worldInit`
 * (DET-1, NTR-5) имеет смысл ровно постольку, поскольку обе стороны собирают
 * представление одинаково. Две похожие сборки, разошедшиеся в порядке спавна,
 * дали бы расхождение хешей на честных данных — то есть отказ входа там, где
 * входить можно.
 *
 * Пролога здесь больше нет: сборку мира — порядок регистрации систем,
 * расстановку (SER-8) и момент хеша `worldInit` — целиком делает
 * `buildSimulation` ядра, опубликованный ровно для этого (NTR-1: сетевому слою
 * доступна только опубликованная поверхность ядра). Прежде эти шаги были здесь
 * повторены, и повтор успел разойтись с оригиналом — расстановка матча шла
 * сырым циклом мимо валидации SER-8. Своего в этом модуле остаётся только
 * матчевое: отказ сборки по NTR-14 и обязательные `players`.
 *
 * Парность с ядром (NTR-8) от этого не теряет смысла: она гоняет записанный
 * матч через `runScenario` и краснеет на первом же тике, если различие в сборке
 * всё-таки появится.
 */
import {
  buildSimulation,
  world as coreWorld,
  type ComponentSchema,
  type DiagnosticsSink,
  type LocomotionOptions,
  type NavigationOptions,
  type PhysicsOptions,
  type PlainWorld,
  type ScenarioSpawn,
  type SceneDef,
  type Simulation,
  type SimulationState,
  type VisibilityOptions,
  type WorldState,
} from '@fluxus/core';

export interface MatchWorldDef {
  readonly scene: SceneDef;
  readonly seed: number;
  /** Порядок задаёт слоты (TICK-5) и входит в воспроизводимость наравне с seed. */
  readonly players: readonly string[];
  /**
   * Расстановка документа прогона (SER-8) — участники этого матча. Расстановку
   * конфига сцены она не замещает: та применяется первой, внутри `loadScene`.
   */
  readonly initial?: readonly ScenarioSpawn[];
  /** Зависимость сборки, а не данные сцены (DI-3) — поэтому здесь, а не в `SceneDef`. */
  readonly physics?: PhysicsOptions;
  readonly locomotion?: LocomotionOptions;
  /**
   * Включение и параметры пересчёта видимости (NTR-14), по той же форме, что поле
   * `visibility` документа прогона сценария (CLI-2). Сцена с флагом `fog` без
   * этого поля — отказ сборки (см. `buildMatchWorld`).
   */
  readonly visibility?: VisibilityOptions;
  /**
   * Включение и параметры поиска пути (NTR-14), по той же форме, что поле
   * `navigation` документа прогона сценария (CLI-2): бюджет раскрытий (`pathfinding`
   * NAV-5) и предел радиуса агента (`terrain` TERR-7). Навигационные данные
   * печутся из ассета террейна сцены (NAV-3), поэтому поле здесь, а не в
   * `SceneDef`: числа геймдизайнера — зависимость сборки, а не данные сцены
   * (DI-3). Обе стороны матча получают его из одного описания (NTR-14) — иначе
   * предсказание клиента водило бы NPC не там, где сервер.
   */
  readonly navigation?: NavigationOptions;
  /**
   * Приёмник трейса (DIAG-8, DIAG-1) — та же опциональная зависимость сборки
   * (DI-5), какой его передаёт прогонщик сценария. Дорога уже существует: ядро
   * нового API не получает, и «матчевость» прогона ему по-прежнему неизвестна
   * (DI-6). Поле здесь, а не в `SceneDef`, по тому же основанию, что физика:
   * это зависимость сборки, а не данные сцены (DI-3).
   */
  readonly diagnostics?: DiagnosticsSink;
}

export interface MatchWorld {
  readonly sim: Simulation;
  readonly state: SimulationState;
  /** Считается после расстановки и до первого тика — ровно тот момент, который DET-1 называет `worldInit`. */
  readonly worldInitHash: string;
}

export function buildMatchWorld(def: MatchWorldDef): MatchWorld {
  // Матч со сценой, включающей туман войны, обязан объявлять пересчёт видимости
  // (NTR-14), и отсутствие объявления — отказ сборки ДО первого тика, а не молча
  // деградировавший матч. Тем пересчёт видимости и отличается от физики, недостача
  // которой ниже деградирует одинаково у всех и видна глазами: фильтрация по
  // маске, которую никто не пересчитывает (NET-12), идёт по значениям начальной
  // расстановки, и её результат — пустой мир у одних, вечно видимый противник у
  // других — читается как игровая ситуация, а не как дефект сборки.
  //
  // Отказ стоит здесь, в ОБЩЕМ пути сборки, а не в конструкторе сервера: сервер и
  // клиент поднимают мир матча одним путём (NTR-14), и клиент, которому
  // зависимости сборки не передали, обязан отвалиться так же явно.
  if (def.scene.fog === true && def.visibility === undefined) {
    throw new Error(
      'конфиг матча: сцена включает туман войны (fog), а пересчёт видимости не объявлен — ' +
        'добавьте поле "visibility" в конфиг матча (NTR-14, FOW-4)',
    );
  }
  // Дальше — общий путь ядра. Состав систем (InputSystem → LocomotionSystem →
  // PhysicsSystem → VisibilitySystem после физики, FOW-6), порядок «носители →
  // расстановка сцены → расстановка матча» (SER-8) и момент хеша `worldInit`
  // (DET-1) заданы там: по этому хешу сверяются клиент и сервер (NTR-5), и
  // второго определения у него быть не должно.
  //
  // `players` матча обязательны (TICK-5) — в отличие от сценария, где прогон без
  // инпутов законен; поэтому поле передаётся всегда, а не по наличию.
  return buildSimulation(
    {
      scene: def.scene,
      seed: def.seed,
      players: def.players,
      ...(def.initial !== undefined ? { initial: def.initial } : {}),
      ...(def.physics !== undefined ? { physics: def.physics } : {}),
      ...(def.locomotion !== undefined ? { locomotion: def.locomotion } : {}),
      ...(def.visibility !== undefined ? { visibility: def.visibility } : {}),
      ...(def.navigation !== undefined ? { navigation: def.navigation } : {}),
    },
    {
      where: 'конфиг матча',
      // Трейс матча снимается ровно тем же способом, что трейс прогона
      // сценария (DIAG-8): подключением sink'а к сборке мира. Своего пути у
      // матча здесь нет и появиться не должно.
      ...(def.diagnostics !== undefined ? { diagnostics: def.diagnostics } : {}),
    },
  );
}

/**
 * Схемы компонентов в ПОРЯДКЕ ОБЪЯВЛЕНИЯ — то, что `snapshotFromPlain` требует
 * для восстановления мира: порядок задаёт битовые id, то есть смысл `maskWords`
 * (SER-7).
 *
 * Порядок восстанавливается из живого мира клиента по `componentId`, а не
 * пересобирается повторением раскладки `loadScene` (объявленные компоненты,
 * затем карта пола, арена, таймскейл, твин, туман). Повторение этой раскладки в
 * сетевом слое было бы вторым её определением: изменилась бы нормативная
 * очерёдность SER-7 — и разошлись бы битовые id при формально одном конфиге.
 *
 * Имена берутся из самой плоской формы: `toPlain` выгружает все хранилища мира,
 * а не только непустые. Компонент, которого у клиента нет, означает разошедшийся
 * контент-пак — то есть отказ входа (NTR-5), а не тихую потерю поля.
 */
export function orderedSchemas(world: WorldState, plain: PlainWorld): ComponentSchema[] {
  const ordered: { id: number; schema: ComponentSchema }[] = [];
  for (const name of Object.keys(plain.components)) {
    const id = coreWorld.componentId(world, name);
    const schema = coreWorld.componentSchema(world, name);
    if (id === undefined || schema === undefined) {
      throw new Error(`снапшот ссылается на компонент "${name}", которого нет в сцене клиента`);
    }
    ordered.push({ id, schema });
  }
  ordered.sort((a, b) => a.id - b.id);
  return ordered.map((entry) => entry.schema);
}
