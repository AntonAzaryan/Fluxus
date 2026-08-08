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

export interface SceneDraftInput {
  /** Значение конфига сцены — как его отдаёт сессия. */
  readonly config: unknown;
  /** Ключи записей расстановки по порядку списка; короче списка — хвост получит запасные. */
  readonly keys?: readonly string[];
  /** Манифест визуалов (ASSET-6): по нему у записи появляется визуальный тип. */
  readonly visuals?: VisualManifest | null;
  /** Значение документа карты кривизны (ED-11); ассетом он ещё может и не быть. */
  readonly curvature?: unknown;
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
  const placements: ScenePlacement[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const entity = alive[carriers + index]!;
    const prefab = entry.prefab;
    // Позиция — поле компонента, а не поле записи: какой компонент её несёт,
    // знает контент, и читается она у мира по конвенции ядра.
    const has = world.hasComponent(state, entity, POSITION_COMPONENT);
    const fx = has ? world.getField(state, entity, POSITION_COMPONENT, 'x') : 0;
    const fy = has ? world.getField(state, entity, POSITION_COMPONENT, 'y') : 0;
    // Точка входной границы рендера (REND-1): Q16.16 → float здесь, и глубже
    // fixed-point не идёт. Уровень под объектом — ответ ядра (TERR-4).
    placements.push({
      key: input.keys?.[index] ?? fallbackKey(index),
      prefab,
      kind: kindOf(state, entity),
      x: fixed.toFloat(fx),
      y: fixed.toFloat(fy),
      level: scene.terrain?.levelAt({ x: fx, y: fy }) ?? 0,
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

  return {
    grid,
    curvature,
    placements,
    failure: reasons.length === 0 ? null : reasons.join('; '),
  };
}
