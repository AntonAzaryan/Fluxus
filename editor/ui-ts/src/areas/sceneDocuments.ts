/**
 * @contribution Производная картинки от документов сцены — часть вклада области
 * сцены, а не каркаса: доменные имена («сцена», «террейн», «расстановка») здесь
 * и должны быть (ED-25).
 *
 * ED-15: «изображение SHALL быть производным от текущего состояния
 * редактируемых документов… Тикающей симуляции в режиме правки MUST NOT быть:
 * вьюпорт рисует начальное состояние сцены, а не её прогон». Этот модуль —
 * ровно та функция: значения открытых документов на входе, набор инстансов
 * (REND-11), сетка террейна (REND-14) и карта кривизны (REND-9) на выходе.
 * Ни THREE, ни DOM здесь нет — поэтому вся производная проверяется headless.
 *
 * ## Почему начальное состояние считает ядро
 *
 * Запись расстановки — это `prefab` и переопределения полей (SER-8), а не
 * «объект с координатами»: где у контента лежит позиция, в каком компоненте и
 * что перекрывает что — знает ядро, и второй его реализации в редакторе быть не
 * может (ED-1, CORE-3). Поэтому набор инстансов снимается с мира, поднятого
 * `loadScene`: `loadScene` применяет расстановку до первого тика (TICK-3,
 * исключение `worldInit`) и ничего не тикает — это и есть «начальное состояние
 * сцены» ED-15 буквально, а не его пересказ.
 *
 * Отсюда же соответствие «запись документа ↔ сущность мира»: порядок спавна
 * нормативен (SER-7) — сперва носители террейна и арены, затем расстановка в
 * порядке списка, — поэтому запись #i отвечает (i + число носителей)-й живой
 * сущности. Нарушение этого соответствия не заминается, а становится причиной
 * отказа: молча показать не тот объект хуже, чем не показать ничего.
 *
 * ## Почему ключ инстанса — дескриптор сессии
 *
 * REND-11 требует ключ, устойчивый к правке полей размещённого: смена позиции
 * обновляет инстанс, а не пересоздаёт его. Индекс в списке таким ключом не
 * является (удаление соседа сдвигает хвост), поэтому ключи приносит сессия —
 * её дескрипторы (`descriptors`) заведены ровно для этого.
 *
 * ## Откуда берётся «где у объекта позиция»
 *
 * ED-16: «Какие компонент и поля их несут, редактор SHALL брать из настройки
 * проекта, а не из зашитого в редактор имени компонента». Поэтому привязка —
 * значение (`PositionBinding`), приходящее сверху вместе с документами, а не
 * литерал в этом файле. Значение по умолчанию берётся у ядра
 * (`POSITION_COMPONENT`) и только у него: это его собственная конвенция, на
 * которую опираются его же нативные системы, и повторять её строкой здесь
 * значило бы завести вторую (ED-1, CORE-3). Проект, у которого позиция лежит
 * иначе, подаёт свою привязку — правится настройка, а не редактор.
 *
 * ## Откуда берётся «где у объекта поворот»
 *
 * Тем же путём и по той же причине (ED-16 называет позицию и поворот вместе), с
 * одной разницей: конвенции поворота у ядра нет вовсе — ни компонента, ни поля,
 * — поэтому и умолчания у этой половины привязки нет. Проект, не назвавший
 * поворот, поворота не хранит, и операция поворота ему недоступна (ED-26): это
 * честнее выдуманного имени компонента.
 *
 * Единица угла при этом ядру принадлежит: `fixed.sin`/`fixed.cos` принимают долю
 * оборота в Q16.16 (полный оборот — 1.0), и второй единицы редактор не вводит.
 * Радианы появляются ровно на входной границе рендера (REND-1), где `yaw`
 * набора инстансов их и требует.
 */
import {
  createTerrainGrid,
  fixed,
  loadScene,
  world,
  POSITION_COMPONENT,
  type SceneDef,
  type ScenarioSpawn,
  type TerrainDef,
  type TerrainGrid,
} from '@game-mvp/core';
import {
  validateCurvatureMap,
  validateManifest,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@game-mvp/assets';
import { kindByTags, type DocumentInstance } from '@game-mvp/render';

/**
 * Размещённое сцены глазами редактора: то же, что отдаётся рендеру набором
 * (REND-11), плюс имя prefab'а — навигатору и инспектору оно нужно, а рендеру
 * нет.
 */
export interface ScenePlacement extends DocumentInstance {
  readonly prefab: string;
  /**
   * Поворот в единице ЯДРА — доле оборота (`fixed.sin`), а не в радианах `yaw`.
   * Поле отдельное, а не выводимое из `yaw` делением, потому что обратный ход
   * через радианы не бит-в-бит: `raw/65536 · 2π / 2π` для примерно седьмой
   * части значений Q16.16 даёт величину чуть ниже исходной, и `fixed.fromFloat`
   * (усечение к нулю, FP-1) возвращает на квант меньше. Поворот, посчитанный
   * от прежнего, терял бы этот квант на каждом нажатии. Ноль — проект не
   * назвал, где лежит поворот (ED-16), и поворачивать нечего.
   */
  readonly turns: number;
}

/**
 * Кадр как функция документов. `failure` — не исключение: правка, сломавшая
 * документ, обязана оставить автора в редакторе с прежней картинкой и
 * названной причиной, а не уронить вьюпорт (ED-8 показывает причину, ED-15
 * требует кадра).
 */
export interface SceneDraft {
  readonly grid: TerrainGrid | null;
  readonly curvature: TerrainCurvatureMap | null;
  readonly placements: readonly ScenePlacement[];
  readonly failure: string | null;
}

/**
 * Полный оборот в радианах: угол ядра — доля оборота, `yaw` рендера — радианы.
 * Не экспортируется намеренно: перевод в радианы делается ровно на входной
 * границе рендера (REND-1) и ровно один раз, а обратного перевода нет вовсе —
 * поворот, который редактор пишет в документ, берётся из `ScenePlacement.turns`.
 */
const TURN_RADIANS = Math.PI * 2;

/** Где у сим-объекта лежит поворот (ED-16): компонент и имя одного его поля. */
export interface RotationBinding {
  readonly component: string;
  readonly field: string;
}

/**
 * Где у сим-объекта лежит позиция (ED-16): компонент и имена двух его полей.
 * Настройка проекта, а не знание редактора — формат расстановки именованных
 * полей позиции не имеет вовсе (SER-8).
 */
export interface PositionBinding {
  readonly component: string;
  readonly x: string;
  readonly y: string;
  /** Где лежит поворот; нет — сцена поворота не хранит, и поворачивать нечего. */
  readonly rotation?: RotationBinding;
}

/**
 * Привязка по умолчанию — конвенция самого ядра (`POSITION_COMPONENT`), на
 * которую опираются его нативные системы. Редактор её не вводит и не копирует:
 * он её импортирует, и проект вправе подать другую.
 */
export const DEFAULT_POSITION_BINDING: PositionBinding = {
  component: POSITION_COMPONENT,
  x: 'x',
  y: 'y',
};

export interface SceneDraftInput {
  /** Значение конфига сцены — как его отдаёт сессия. */
  readonly config: unknown;
  /** Ключи записей расстановки по порядку списка; короче списка — хвост получит запасные. */
  readonly keys?: readonly string[];
  /** Манифест визуалов (ASSET-6): по нему у записи появляется визуальный тип. */
  readonly visuals?: VisualManifest | null;
  /** Значение документа карты кривизны (ED-11); ассетом он ещё может и не быть. */
  readonly curvature?: unknown;
  /** Где у объекта позиция (ED-16); нет — конвенция ядра. */
  readonly position?: PositionBinding;
}

interface SceneShape {
  readonly terrain?: TerrainDef;
  readonly arena?: unknown;
  readonly initial?: readonly ScenarioSpawn[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Ключ записи, когда сессия дескрипторов не дала (например, документ не открыт). */
const fallbackKey = (index: number): string => `#${index}`;

/**
 * Сетка террейна из ассета, лежащего в конфиге сцены (TERR-2). Считает её
 * ядро: cliff-геометрию, углы рамп и уровни выводит оно (TERR-5), а рендер
 * только принимает уже производную сетку (REND-14).
 */
export function terrainOf(config: unknown): TerrainGrid | null {
  const shape = config as SceneShape | null;
  const def = shape?.terrain;
  return def === undefined ? null : createTerrainGrid(def);
}

/**
 * Набор инстансов из начальной расстановки конфига (SER-7, SER-8) —
 * декларативный вход документного источника (REND-11).
 */
export function placementsOf(input: SceneDraftInput): readonly ScenePlacement[] {
  const shape = input.config as SceneShape | null;
  const entries = shape?.initial ?? [];
  if (entries.length === 0) return [];

  const scene = loadScene(input.config as SceneDef);
  const state = scene.world;
  const alive = world.listAlive(state);
  // Носители террейна и арены спавнятся первыми (SER-7) — их ID предшествуют
  // расстановке, а сами они ни в наборе, ни в навигаторе не участвуют.
  const carriers = alive.length - entries.length;
  if (carriers < 0) {
    throw new Error(
      `расстановка: записей ${entries.length}, а живых сущностей начального состояния ${alive.length}`,
    );
  }

  const visuals = input.visuals ?? null;
  const kindOf = kindByTags(visuals === null ? [] : Object.keys(visuals.entities));
  const at = input.position ?? DEFAULT_POSITION_BINDING;
  const spin = at.rotation;
  const placements: ScenePlacement[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const entity = alive[carriers + index]!;
    const prefab = entry.prefab;
    // Позиция — поле компонента, а не поле записи: какой компонент её несёт,
    // говорит настройка проекта (ED-16), а значения читаются у поднятого мира.
    const has = world.hasComponent(state, entity, at.component);
    const fx = has ? world.getField(state, entity, at.component, at.x) : 0;
    const fy = has ? world.getField(state, entity, at.component, at.y) : 0;
    // Поворот — вторая половина той же настройки; проект, её не назвавший,
    // поворота не хранит, и курса у инстанса нет вовсе.
    const spun = spin !== undefined && world.hasComponent(state, entity, spin.component);
    // Доля оборота — единица ядра; её и держит запись. `raw / 65536` точно в
    // double (степень двойки), поэтому обратно в Q16.16 она уходит без потери.
    const turns = fixed.toFloat(spun ? world.getField(state, entity, spin.component, spin.field) : 0);
    // Точка входной границы рендера (REND-1): Q16.16 → float здесь, и глубже
    // fixed-point не идёт. Уровень под объектом — ответ ядра (TERR-4).
    placements.push({
      key: input.keys?.[index] ?? fallbackKey(index),
      prefab,
      kind: kindOf(state, entity),
      x: fixed.toFloat(fx),
      y: fixed.toFloat(fy),
      level: scene.terrain?.levelAt({ x: fx, y: fy }) ?? 0,
      turns,
      // Радианы — только рендеру (REND-1): его `yaw` их и требует.
      ...(spin === undefined ? {} : { yaw: turns * TURN_RADIANS }),
    });
  }
  return placements;
}

/**
 * Карта кривизны из значения документа (ED-11, REND-14): несохранённый
 * документ кисти ассетом ещё не является, и ждать его записи значило бы
 * показывать автору не то, что он рисует.
 */
export function curvatureOf(value: unknown): TerrainCurvatureMap | null {
  if (value === undefined || value === null) return null;
  const checked = validateCurvatureMap(value);
  if (!checked.ok) throw new Error(`карта кривизны: ${checked.errors.join('; ')}`);
  return checked.map;
}

/** Манифест визуалов из значения документа (ASSET-6). Разбирает его модуль ассетов. */
export function visualsOf(value: unknown): VisualManifest {
  const checked = validateManifest(value);
  if (!checked.ok) throw new Error(`манифест визуалов: ${checked.errors.join('; ')}`);
  return checked.manifest;
}

/**
 * Кадр целиком. Части независимы намеренно: сломанная расстановка не должна
 * гасить террейн, а несовпадающая карта кривизны — расстановку. Причины
 * складываются в одну строку — показывает её область, а разбирает автор.
 */
export function sceneDraft(input: SceneDraftInput): SceneDraft {
  const reasons: string[] = [];
  let grid: TerrainGrid | null = null;
  let curvature: TerrainCurvatureMap | null = null;
  let placements: readonly ScenePlacement[] = [];

  try {
    grid = terrainOf(input.config);
  } catch (error) {
    reasons.push(message(error));
  }
  try {
    curvature = curvatureOf(input.curvature);
  } catch (error) {
    reasons.push(message(error));
  }
  try {
    placements = placementsOf(input);
  } catch (error) {
    reasons.push(message(error));
  }

  // Сравнения сеток кривизны и террейна здесь нет намеренно: это отношение
  // между двумя документами, и правило для него одно — `editor.curvatureGrid`
  // слоя валидации (ED-11). Кадр его не повторяет: вторая реализация правила,
  // у которого есть источник, расходится с ним по определению (ED-1, CORE-3).
  return {
    grid,
    curvature,
    placements,
    failure: reasons.length === 0 ? null : reasons.join('; '),
  };
}
