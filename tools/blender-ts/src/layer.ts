/**
 * Генерация пространственного слоя из объектов источника: записи начальной
 * расстановки (`serialization` SER-8) и записи `decorations` парного
 * presentation-документа (`presentation-scene` PRES-2).
 *
 * Слой здесь только СЧИТАЕТСЯ — в память. Запись в документы делает операция
 * авторинга editor-core с каноническим сохранением (BLND-5, ED-29, ED-21), и
 * второго пути записи у конвейера нет.
 *
 * ## Откуда берётся «где у объекта позиция»
 *
 * Формат расстановки именованных полей позиции не имеет вовсе (SER-8): позиция
 * и курс записываются переопределением полей компонентов, а какие это компонент
 * и поля — настройка проекта (ED-16). Импортёр её MUST NOT вводить (BLND-3),
 * поэтому привязка приходит ЗНАЧЕНИЕМ (`PositionBinding`), объявленным у
 * редактора (`@game-mvp/editor-core`), а умолчание берётся у ядра — ровно тем
 * же способом, что у расстановки редактора. Проект, не назвавший, где лежит
 * поворот, поворота не хранит, и
 * курс сим-объекта в документ не пишется: выдуманное имя компонента было бы
 * хуже отсутствующего поля.
 *
 * ## Квантование
 *
 * Квантует импортёр до записи (BLND-4), но своей арифметики у него нет:
 * сим-величины идут через `fixed.fromFloat` ядра (FP-1), presentation-величины
 * — через `quantizeDecoration*` модуля, которому принадлежит шаг (PRES-3).
 * Второго определения шага и второго умножения на 65536 в репозитории быть не
 * должно (ED-1, CORE-3).
 *
 * ## Порядок записей
 *
 * Лексикографически по имени объекта Blender (BLND-4) — по кодовым единицам,
 * а не `localeCompare`: порядок не должен зависеть от локали среды. Следствие
 * названо честно: переименование и добавление объекта двигают позиции записей
 * `initial`, то есть выданные ID и хеш `worldInit`.
 */
import { fixed, FIXED_ONE, type ComponentSchema, type PrefabDef } from '@game-mvp/core';
import { quantizeDecorationLength, quantizeDecorationYaw, resolveVisual, type VisualManifest } from '@game-mvp/assets';
import {
  DEFAULT_POSITION_BINDING,
  type JsonObject,
  type JsonValue,
  type PositionBinding,
} from '@game-mvp/editor-core';
import { SKIN_KEY, type SourceObject } from './normalize.js';

/**
 * Привязка позиции и поворота (ED-16) — общая с расстановкой редактора и потому
 * объявленная у него: `@game-mvp/editor-core`, `project/binding.ts`. Реэкспорт,
 * а не второе объявление: состав у неё один, второй разошёлся бы молча (ED-1).
 */
export {
  DEFAULT_POSITION_BINDING,
  type PositionBinding,
  type RotationBinding,
} from '@game-mvp/editor-core';

/** Важность находки: «ошибка» останавливает запись целиком (BLND-6). */
export type FindingSeverity = 'error' | 'warning';

/**
 * Находка импорта. Адрес — имя объекта Blender, то самое, которое автор видит в
 * outliner (BLND-6); путь в целевом документе его не заменяет и на этой фазе
 * ещё не существует.
 */
export interface Finding {
  readonly severity: FindingSeverity;
  /** Имя объекта Blender; пусто — находка не об объекте. */
  readonly object: string;
  readonly message: string;
}

/**
 * Сетка ассета террейна цели (TERR-2): с ней обязан совпасть terrain-объект
 * источника, и из неё же берётся сетка карты кривизны (ASSET-7). Размеры и
 * `tileSize` импорт НЕ переписывает — они задают цель, а не приезжают из
 * Blender (BLND-9: переписываются карты уровней и вида клеток).
 */
export interface TargetTerrain {
  readonly width: number;
  readonly height: number;
  /** Размер клетки в Q16.16 (TERR-2). */
  readonly tileSize: number;
}

/** Карты ассета террейна (TERR-3) — то единственное, что импорт в нём пишет. */
export interface TerrainMaps {
  readonly levels: readonly string[];
  readonly flags: readonly string[];
}

/** Карта кривизны (ASSET-7): документ целиком — производные данные (BLND-2). */
export interface CurvatureMap {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly string[];
}

/**
 * Что клеточным слоям нужно знать о цели: сетка ассета террейна и адрес
 * документа карты кривизны (его называет манифест — `terrain.curvatureMap`,
 * ASSET-7). Оба — знание о ЦЕЛИ, а не об источнике: сетку импорт не выдумывает,
 * а сверяет.
 */
export interface CellLayerContext {
  readonly terrain?: TargetTerrain | null;
  /** ID документа карты кривизны; `null` — манифест её не адресует. */
  readonly curvatureMap?: string | null;
}

/**
 * Что импортёру нужно знать о цели, чтобы проверить источник до записи:
 * состав сцены (prefabs и схемы компонентов — SER-7) и манифест визуалов
 * (ASSET-9). Манифеста нет — ссылки `visual` не проверяются вовсе: отсутствие
 * документа не то же самое, что отсутствие в нём ключа.
 */
export interface SpatialLayerContext extends CellLayerContext {
  readonly components: readonly ComponentSchema[];
  readonly prefabs?: readonly PrefabDef[];
  readonly visuals?: VisualManifest | null;
  /** Привязка позиции и поворота (ED-16); нет — конвенция ядра. */
  readonly binding?: PositionBinding;
}

/**
 * Целевой пространственный слой: два списка записей в порядке BLND-4 и — при
 * соответствующих объектах источника — клеточные слои террейна и кривизны
 * (BLND-9, BLND-10). Значения — уже JSON документов, а не промежуточная модель:
 * второе представление обязано было бы уметь превращаться обратно и разошлось
 * бы с первым (ED-3).
 *
 * Отсутствие слота значит «источник его не даёт»: ассет тогда не переписывается
 * вовсе и остаётся за редактором и руками (BLND-2). Пустой слот и отсутствующий
 * — разные вещи, поэтому поля необязательные, а не пустые по умолчанию.
 */
export interface SpatialLayer {
  /** Записи `initial` конфига сцены (SER-8). */
  readonly initial: readonly JsonObject[];
  /** Записи `decorations` парного документа (PRES-2). */
  readonly decorations: readonly JsonObject[];
  /** Карты ассета террейна сцены (TERR-3); нет — в источнике нет terrain-объекта. */
  readonly terrain?: TerrainMaps;
  /** Карта кривизны (ASSET-7); нет — в источнике нет curvature-объекта. */
  readonly curvature?: CurvatureMap;
  readonly findings: readonly Finding[];
}

/** Разделитель custom property вида `<Компонент>.<поле>` (BLND-3). */
const FIELD_SEPARATOR = '.';

/**
 * Величина автора в валидный Q16.16 (FP-1); `null` — ядро такой величины не
 * представляет. Квантование — вызов ядра, своё здесь только чтение обратно:
 * контейнер Q16.16 — i32, и вне диапазона он заворачивается молча, то есть
 * объект уехал бы на другой край арены без единого сообщения.
 */
export function quantizedFixed(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const raw = fixed.fromFloat(value);
  return Math.abs(fixed.toFloat(raw) - value) < 1 / FIXED_ONE ? raw : null;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Сравнение по кодовым единицам: порядок записей не зависит от локали (BLND-4). */
export function compareObjectNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Sink {
  readonly findings: Finding[];
  failed: boolean;
}

function error(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'error', object, message });
  sink.failed = true;
}

function warning(sink: Sink, object: string, message: string): void {
  sink.findings.push({ severity: 'warning', object, message });
}

/**
 * Значение поля компонента в представлении его типа (SER-8): `fixed` — целым
 * Q16.16, `i32` — целым. Нецелое в `i32` не округляется: округление за автора
 * молча сдвинуло бы `worldInit` (тот же довод, что у высот террейна, BLND-9).
 */
function fieldValue(
  sink: Sink,
  object: string,
  component: string,
  field: string,
  type: 'fixed' | 'i32',
  raw: number,
): number | null {
  const where = `${component}.${field}`;
  if (!Number.isFinite(raw)) {
    error(sink, object, `${where}: значение не является конечным числом`);
    return null;
  }
  if (type === 'fixed') {
    const value = quantizedFixed(raw);
    if (value === null) {
      error(sink, object, `${where}: значение ${raw} вне представимого Q16.16 (FP-1)`);
      return null;
    }
    return value;
  }
  if (!Number.isInteger(raw)) {
    error(sink, object, `${where}: поле типа i32, а значение ${raw} не целое — округлять импорт не вправе`);
    return null;
  }
  if (raw < INT32_MIN || raw > INT32_MAX) {
    error(sink, object, `${where}: значение ${raw} вне диапазона i32`);
    return null;
  }
  return raw;
}

/**
 * Занято ли поле трансформом объекта (BLND-3): позиция и курс приходят из
 * матрицы узла, и custom property того же адреса — не второй источник, а
 * противоречие.
 */
function isBoundField(binding: PositionBinding, component: string, field: string): boolean {
  if (component === binding.component && (field === binding.x || field === binding.y)) return true;
  const rotation = binding.rotation;
  return rotation !== undefined && component === rotation.component && field === rotation.field;
}

/** Переопределения записи расстановки: «компонент → поле → значение» (CMD-6). */
type Overrides = Record<string, Record<string, number>>;

function put(overrides: Overrides, component: string, field: string, value: number): void {
  const target = (overrides[component] ??= {});
  target[field] = value;
}

/** Ключи объекта в лексикографическом порядке — дифф не зависит от порядка обхода. */
function sortedObject(source: Readonly<Record<string, number>>): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const key of Object.keys(source).sort(compareObjectNames)) out[key] = source[key] as number;
  return out;
}

function sortedOverrides(overrides: Overrides): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const component of Object.keys(overrides).sort(compareObjectNames)) {
    out[component] = sortedObject(overrides[component] as Record<string, number>);
  }
  return out;
}

/**
 * Запись начальной расстановки из объекта с `prefab` (BLND-3). Отказ не
 * прекращает разбор остальных объектов: автор обязан увидеть все ошибки
 * источника разом, а не по одной на прогон, — записано всё равно ничего не
 * будет (BLND-6).
 */
function placementRecord(
  sink: Sink,
  source: SourceObject,
  binding: PositionBinding,
  schemas: ReadonlyMap<string, ComponentSchema>,
  prefabs: ReadonlyMap<string, PrefabDef> | null,
): JsonObject | null {
  const name = source.semanticValue;
  if (name === '') {
    error(sink, source.name, 'свойство "prefab" — непустая строка с именем prefab\'а (SER-8)');
    return null;
  }
  const prefab = prefabs?.get(name);
  if (prefabs !== null && prefab === undefined) {
    error(sink, source.name, `prefab "${name}" не объявлен конфигом сцены (SER-8)`);
    return null;
  }

  const overrides: Overrides = {};
  const write = (component: string, field: string, raw: number): void => {
    const schema = schemas.get(component);
    if (schema === undefined) {
      error(sink, source.name, `компонент "${component}" не объявлен схемами сцены (ECS-3)`);
      return;
    }
    const type = schema.fields[field];
    if (type === undefined) {
      error(sink, source.name, `поле "${field}" не объявлено схемой компонента "${component}" (ECS-3)`);
      return;
    }
    if (prefab !== undefined && prefab.components[component] === undefined) {
      error(sink, source.name, `компонент "${component}" не входит в состав prefab'а "${name}" (CMD-6)`);
      return;
    }
    const value = fieldValue(sink, source.name, component, field, type, raw);
    if (value !== null) put(overrides, component, field, value);
  };

  write(binding.component, binding.x, source.x);
  write(binding.component, binding.y, source.y);
  if (binding.rotation !== undefined) {
    write(binding.rotation.component, binding.rotation.field, source.yaw);
    // Зеркало курсом не выражается: разложение зеркального трансформа отдаёт
    // курс, отличающийся на пол-оборота (BLND-3). Позиции это не касается,
    // поэтому у сцены без поворота и предупреждения нет.
    if (source.mirrored) {
      warning(sink, source.name, 'трансформ зеркальный; курс зеркала не выражает (BLND-3)');
    }
  }

  for (const key of Object.keys(source.extras).sort(compareObjectNames)) {
    const separator = key.indexOf(FIELD_SEPARATOR);
    if (separator <= 0 || separator === key.length - 1) continue;
    const component = key.slice(0, separator);
    const field = key.slice(separator + 1);
    if (isBoundField(binding, component, field)) {
      // Позиция и курс берутся ИЗ ТРАНСФОРМА (BLND-3), и молчаливо предпочесть
      // одно из двух значений импортёр не вправе: автор двигал бы объект в
      // Blender, а в кадре ничего бы не менялось.
      error(
        sink,
        source.name,
        `"${key}": позиция и курс берутся из трансформа объекта (BLND-3), а не из custom property`,
      );
      continue;
    }
    const raw = source.extras[key];
    if (typeof raw === 'string') {
      error(sink, source.name, `"${key}": значение поля компонента — число, а не строка "${raw}"`);
      continue;
    }
    write(component, field, typeof raw === 'boolean' ? (raw ? 1 : 0) : (raw as number));
  }

  return { prefab: name, overrides: sortedOverrides(overrides) };
}

/**
 * Запись decoration из объекта с `visual` (BLND-3, PRES-2). Состав записи
 * закрыт, и полей сверх него импорт не пишет; умолчания (`yaw` 0, `scale` 1) не
 * записываются вовсе — отсутствующее и равное умолчанию в формате неразличимы,
 * а лишний ключ был бы шумом в диффе.
 */
function decorationRecord(sink: Sink, source: SourceObject, context: SpatialLayerContext): JsonObject | null {
  const key = source.semanticValue;
  if (key === '') {
    error(sink, source.name, 'свойство "visual" — непустая строка с ключом манифеста (PRES-2)');
    return null;
  }
  const visuals = context.visuals;
  if (visuals != null && resolveVisual(visuals, key) === undefined) {
    // Предупреждение, а не отказ (BLND-6): в рантайме такая запись даёт
    // заглушку (PRES-2), и чинится она правкой манифеста — отказ запер бы автора.
    warning(sink, source.name, `ключ "${key}" не разрешается в запись манифеста визуалов (ASSET-9)`);
  }

  const x = quantizeDecorationLength(source.x);
  const y = quantizeDecorationLength(source.y);
  const yaw = quantizeDecorationYaw(source.yaw);
  const scale = quantizeDecorationLength(source.scale);
  if (x === null || y === null || yaw === null || scale === null) {
    error(sink, source.name, 'позиция, курс либо масштаб не являются конечными числами (PRES-3)');
    return null;
  }
  if (scale <= 0) {
    error(sink, source.name, `масштаб ${scale} не превышает нуля (PRES-2)`);
    return null;
  }
  if (!source.uniformScale) {
    warning(sink, source.name, 'масштаб неодинаков по осям; в запись уходит масштаб по оси X (PRES-2)');
  }
  if (source.mirrored) {
    // Зеркало не выражают ни `yaw`, ни положительный `scale` записи (PRES-2):
    // разложение отдаёт курс, отличающийся на пол-оборота, и объект в кадре
    // движка окажется не тем, что автор видит во вьюпорте Blender (BLND-11).
    warning(
      sink,
      source.name,
      'трансформ зеркальный; запись decoration зеркала не выражает — в документ уходит курс без него (PRES-2)',
    );
  }

  const skin = source.extras[SKIN_KEY];
  if (skin !== undefined && typeof skin !== 'string') {
    error(sink, source.name, `"${SKIN_KEY}": имя скина — строка (PRES-2)`);
    return null;
  }

  // Порядок ключей — порядок состава записи в PRES-2: сохранение канонично, но
  // ключи оно не переставляет (ED-21), и порядок задаёт тот, кто записи строит.
  const record: Record<string, JsonValue> = { visual: key, x, y };
  if (yaw !== 0) record['yaw'] = yaw;
  if (scale !== 1) record['scale'] = scale;
  if (skin !== undefined && skin !== '') record['skin'] = skin;
  return record;
}

/**
 * Целевой пространственный слой источника. Ошибки собираются все до одной и
 * возвращаются вместе со слоем: решение «писать или не писать» принимает
 * вызывающий (BLND-6), а не эта функция, — ей нечего писать.
 */
export function generateSpatialLayer(
  objects: readonly SourceObject[],
  context: SpatialLayerContext,
): SpatialLayer {
  const sink: Sink = { findings: [], failed: false };
  const binding = context.binding ?? DEFAULT_POSITION_BINDING;
  const schemas = new Map(context.components.map((schema) => [schema.name, schema]));
  const prefabs = context.prefabs === undefined ? null : new Map(context.prefabs.map((def) => [def.name, def]));

  const semantic = objects.filter((object) => object.semantics.length > 0);
  const ordered = [...semantic].sort((a, b) => compareObjectNames(a.name, b.name));

  const seen = new Set<string>();
  for (const object of ordered) {
    if (seen.has(object.name)) {
      // Имена объектов Blender уникальны принудительно; совпадение означает
      // источник не из Blender, и порядок записей от него уже не функция
      // (BLND-4).
      error(sink, object.name, 'имя объекта встречается дважды — порядок записей перестал быть однозначным (BLND-4)');
    }
    seen.add(object.name);
    if (object.semantics.length > 1) {
      error(
        sink,
        object.name,
        `семантических свойств несколько (${object.semantics.join(', ')}) — размещение принадлежит одному слою (BLND-3)`,
      );
    }
  }

  const initial: JsonObject[] = [];
  const decorations: JsonObject[] = [];
  for (const object of ordered) {
    if (object.semantics.length !== 1) continue;
    const kind = object.semantics[0];
    if (kind === 'prefab') {
      const record = placementRecord(sink, object, binding, schemas, prefabs);
      if (record !== null) initial.push(record);
    } else if (kind === 'visual') {
      const record = decorationRecord(sink, object, context);
      if (record !== null) decorations.push(record);
    }
    // `terrain` и `curvature` — клеточные данные (BLND-9, BLND-10): в слой
    // размещений они не попадают, и вспомогательными объектами не являются.
  }

  return { initial, decorations, findings: sink.findings };
}

/** Есть ли среди находок хоть одна ошибка: запись при этом не выполняется целиком (BLND-6). */
export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.severity === 'error');
}
