/**
 * @contribution Производная картинки от документов сцены — часть вклада области
 * сцены, а не каркаса: доменные имена («сцена», «террейн», «расстановка») здесь
 * и должны быть (ED-25).
 *
 * ED-15: «изображение SHALL быть производным от текущего состояния
 * редактируемых документов… Тикающей симуляции в режиме правки MUST NOT быть:
 * вьюпорт рисует начальное состояние сцены, а не её прогон». Этот модуль —
 * ровно та функция: значения открытых документов на входе, набор инстансов
 * (REND-11), набор decoration-инстансов (REND-18), сетка террейна (REND-14) и
 * карта кривизны (REND-9) на выходе.
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
 * литерал в этом файле. Само объявление привязки и её умолчание живут в
 * `@fluxus/editor-core` — у слоя расстановки и у импортёра конвейера Blender
 * она одна и та же (BLND-3), — а умолчание берётся у ядра и только у него: это
 * его собственная конвенция, на которую опираются его же нативные системы, и
 * повторять её строкой значило бы завести вторую (ED-1, CORE-3). Проект, у
 * которого позиция лежит иначе, подаёт свою привязку — правится настройка, а не
 * редактор.
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
 *
 * ## Почему у декораций всё проще
 *
 * Начальное состояние сцены считает ядро, потому что запись расстановки — это
 * prefab и переопределения полей, а где лежит позиция, знает мир. У декорации
 * сим-стороны нет вовсе (ED-19): позиция, курс, масштаб и скин лежат прямо в
 * записи парного документа (PRES-2), и поднимать ради них мир было бы не у кого
 * спрашивать. Отсюда и `decorationsOf` без `loadScene`, и десятичные величины
 * вместо Q16.16 (PRES-3) — конверсии на входе рендера они не требуют.
 *
 * Общего у двух наборов ровно одно, и оно существенное: ключ — дескриптор
 * сессии. Списку `decorations` он выдаётся так же, как списку `initial`, и
 * отсюда единообразие выделения (ED-17) получается не отдельной работой.
 */
import {
  createTerrainGrid,
  fixed,
  loadScene,
  world,
  type SceneDef,
  type ScenarioSpawn,
  type TerrainDef,
  type TerrainGrid,
} from '@fluxus/core';
import {
  validateCurvatureMap,
  validateManifest,
  validatePresentationScene,
  type PresentationLighting,
  type PresentationSceneContext,
  type PresentationPostprocess,
  type PresentationWater,
  type TerrainCurvatureMap,
  type VisualManifest,
} from '@fluxus/assets';
import { decorationInstanceOf, kindByTags, type DecorationInstance, type DocumentInstance } from '@fluxus/render';

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
 * Размещённая декорация глазами редактора: то же, что отдаётся рендеру набором
 * (REND-18), плюс две величины документа, которых рендеру не нужно, — ключ вида
 * строкой и курс в доле оборота.
 */
export interface SceneDecoration extends DecorationInstance {
  /**
   * Ключ вида, КАК ОН ЗАПИСАН в документе. Отдельно от `kind` потому, что
   * `kind` типизирован как «может не рисоваться», а подпись строки навигатора и
   * адрес находки валидации у записи есть всегда — даже когда ключ ни во что не
   * разрешается (PRES-2: в рантайме это заглушка, а не отсутствие записи).
   */
  readonly visual: string;
  /**
   * Курс в единице ДОКУМЕНТА — доле оборота (PRES-2), а не в радианах `yaw`
   * рендера. Поле отдельное по той же причине, что `turns` у сим-объекта:
   * поворот, посчитанный от прежнего через радианы, копил бы погрешность
   * обратного хода на каждом нажатии.
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
  /**
   * Декорации парного presentation-документа (PRES-1) — третий набор рендера
   * (REND-18), а не часть `placements`: продюсеров они не касаются и сменой
   * режима не гасятся.
   */
  readonly decorations: readonly SceneDecoration[];
  /**
   * Секция `lighting` парного документа (PRES-2) — вход подсистемы освещения
   * вьюпорта. `undefined` — секции нет либо документ не разбирается: и то и
   * другое означает документированные умолчания света, а причину сломанного
   * документа кадр уже назвал разбором декораций.
   */
  readonly lighting?: PresentationLighting;
  /**
   * Секция `postprocess` парного документа (PRES-2, `rendering` REND-34) — вход
   * подсистемы пост-обработки кадра; нет секции — её умолчания, то есть кадр
   * без единого её прохода.
   */
  readonly postprocess?: PresentationPostprocess;
  /**
   * Секция `water` парного документа (PRES-2, `rendering` REND-35) — вход
   * подсистемы воды вьюпорта; нет секции — сцена без воды. Она здесь по той же
   * причине, что свет и пост-обработка: кисть кривизны (ED-11) правит дно
   * лощины под водоёмом, и автор обязан видеть новый берег не позже следующего
   * кадра (ED-15), а не после сохранения и перезапуска.
   */
  readonly water?: PresentationWater;
  /**
   * Манифест визуалов кадра (ASSET-6). Он здесь по той же причине, по которой
   * здесь сетка и кривизна: манифест — такой же редактируемый документ (ED-14),
   * а кадр есть функция ТЕКУЩЕГО состояния документов (ED-15). Отдаётся он
   * подсистеме моделей целиком (REND-17); `null` — документ не разбирается, и
   * тогда переподавать нечего: прежний манифест лучше сломанного.
   */
  readonly visuals: VisualManifest | null;
  readonly failure: string | null;
}

/**
 * Имена полей записи decoration (PRES-2). Лежат здесь, а не рядом с операциями
 * декораций, потому что читают их обе стороны: и операции слоя, и операции
 * размещённого, общие на оба документа пары. Модуль формата — единственное
 * место, откуда их видно всем, и цикла импортов при этом не возникает.
 */
export const DECORATION_FIELDS = {
  visual: 'visual',
  x: 'x',
  y: 'y',
  yaw: 'yaw',
  scale: 'scale',
  skin: 'skin',
} as const;

/**
 * Слой, которому принадлежит размещённое (ED-19): сим-объект в расстановке
 * конфига сцены или decoration в парном документе. Операции, действующие на
 * выделение целиком (перемещение, поворот, удаление — ED-17), различают их
 * этим параметром: величины квантуются по-разному (FP-1 против PRES-3), а
 * выделение по построению бывает смешанным.
 */
export type PlacementLayer = 'sim' | 'decoration';

/**
 * Полный оборот в радианах: угол ядра — доля оборота, `yaw` рендера — радианы.
 * Не экспортируется намеренно: перевод в радианы делается ровно на входной
 * границе рендера (REND-1) и ровно один раз, а обратного перевода нет вовсе —
 * поворот, который редактор пишет в документ, берётся из `ScenePlacement.turns`.
 */
const TURN_RADIANS = Math.PI * 2;

/**
 * Где у сим-объекта лежат позиция и поворот (ED-16). Объявление живёт в
 * `@fluxus/editor-core` (`project/binding.ts`) и реэкспортируется отсюда:
 * потребителей у привязки два — инструменты расстановки этого пакета и импортёр
 * конвейера Blender (`blender-pipeline` BLND-3, BLND-5), — а этот пакет DOM-ный
 * и в headless-инструмент не тянется. Реэкспорт, а не второе объявление: у
 * состава привязки один источник, и расходиться ему не с чем.
 */
export {
  DEFAULT_POSITION_BINDING,
  type PositionBinding,
  type RotationBinding,
} from '@fluxus/editor-core';
import { DEFAULT_POSITION_BINDING, type PositionBinding } from '@fluxus/editor-core';

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
  /**
   * Значение парного presentation-документа (PRES-1); `undefined` и `null` —
   * сцена без декораций, и это законное состояние, а не отсутствие данных.
   */
  readonly presentation?: unknown;
  /** Ключи записей `decorations` по порядку списка — дескрипторы сессии (ED-29). */
  readonly decorationKeys?: readonly string[];
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
 * Набор decoration-инстансов из парного документа (PRES-2) — декларативный вход
 * третьего набора рендера (REND-18).
 *
 * Мира здесь не поднимается, и это разница по существу, а не оптимизация: у
 * декорации сим-стороны нет вовсе (ED-19), позиция лежит прямо в записи, и
 * спрашивать её у `loadScene` было бы не у кого. Отсюда же простота ключей —
 * дескрипторы сессии выдаются списку `decorations` ровно так же, как списку
 * `initial`, и устойчивость к правке соседей получается тем же механизмом.
 *
 * Ключ вида уходит в набор КАК ЕСТЬ, без сверки с манифестом: неразрешимую
 * ссылку рендер рисует заглушкой с предупреждением, а подсвечивает её правило
 * валидации `editor.decorationVisual` (PRES-2) — вторая проверка здесь была бы
 * вторым описанием того же нарушения (ED-1, ED-30).
 */
export function decorationsOf(
  input: SceneDraftInput,
  grid?: TerrainGrid | null,
): readonly SceneDecoration[] {
  const value = input.presentation;
  if (value === undefined || value === null) return [];
  const checked = validatePresentationScene(value, sceneContext(grid));
  if (!checked.ok) throw new Error(`presentation-документ: ${checked.errors.join('; ')}`);

  return checked.scene.decorations.map((record, index) => ({
    // Перевод в радианы и дефолты полей — общий `decorationInstanceOf` рендера
    // (REND-1): правило конверсии одно на вьюпорт и демо, второй копии нет
    // (ED-30). Флаг walkable (PRES-2) едет в набор как есть: его читает единое
    // поле высот (REND-9), а не редактор.
    ...decorationInstanceOf(record, input.decorationKeys?.[index] ?? fallbackKey(index)),
    visual: record.visual,
    turns: record.yaw ?? 0,
  }));
}

/**
 * Секции парного документа одним разбором: конфигурация освещения (PRES-2,
 * REND-29) и конфигурация пост-обработки кадра (REND-34). Вместе, а не по
 * функции на секцию: второго разбора документа они не стоят по существу — свет,
 * пост-обработка и декорации живут в одном файле, и все нужны кадру целиком.
 *
 * Сломанный документ здесь МОЛЧИТ намеренно: причину уже назвал `decorationsOf`
 * (ED-8 требует её один раз, а не трижды), а сцена без разобранных секций
 * рисуется умолчаниями подсистем — законный кадр, а не отказ вьюпорта.
 */
function sectionsOf(
  input: SceneDraftInput,
  grid: TerrainGrid | null | undefined,
): {
  readonly lighting?: PresentationLighting;
  readonly postprocess?: PresentationPostprocess;
  readonly water?: PresentationWater;
} {
  const value = input.presentation;
  if (value === undefined || value === null) return {};
  const checked = validatePresentationScene(value, sceneContext(grid));
  if (!checked.ok) return {};
  return {
    ...(checked.scene.lighting === undefined ? {} : { lighting: checked.scene.lighting }),
    ...(checked.scene.postprocess === undefined ? {} : { postprocess: checked.scene.postprocess }),
    ...(checked.scene.water === undefined ? {} : { water: checked.scene.water }),
  };
}

/**
 * Что валидация парного документа знает о сцене (PRES-1): пока это только сетка
 * террейна — клеточная карта секции `water` адресует её клетки (REND-35).
 *
 * Состояний ТРИ, и различать их обязательно:
 *
 * - сетка есть — карта сверяется с её размерами;
 * - `null` — конфиг разобран, и террейна у сцены НЕТ: секция воды у такой сцены
 *   отвергается, привязать её карту не к чему;
 * - `undefined` — сетка НЕИЗВЕСТНА (конфига в сессии нет, либо он не
 *   разбирается). Это не «сцены без террейна», и толковать это так значило бы
 *   гасить парный слой от поломки сим-документа — ровно наоборот инварианту
 *   PRES-4, которым этот модуль и живёт: сломанная сцена не отнимает у автора
 *   ни декораций, ни света, ни пост-обработки.
 */
function sceneContext(grid: TerrainGrid | null | undefined): PresentationSceneContext {
  if (grid === undefined) return {};
  return { terrain: grid === null ? null : { width: grid.width, height: grid.height } };
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
  /**
   * Разобран ли конфиг настолько, чтобы судить о сетке. `false` — конфига в
   * черновике нет либо он сломан: сетка НЕИЗВЕСТНА, и парный слой от этого не
   * гаснет (PRES-4, см. `sceneContext`).
   */
  let terrainKnown = false;
  let curvature: TerrainCurvatureMap | null = null;
  let placements: readonly ScenePlacement[] = [];
  let decorations: readonly SceneDecoration[] = [];

  try {
    grid = terrainOf(input.config);
    // Конфиг разобран: «сетка есть» и «террейна у сцены нет» теперь различимы.
    terrainKnown = input.config !== undefined && input.config !== null;
  } catch (error) {
    reasons.push(message(error));
  }
  const terrain = terrainKnown ? grid : undefined;
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
  // Сломанный парный документ не гасит ни террейн, ни расстановку: слой
  // изолирован от симуляции (PRES-4), и картинка без декораций — законный кадр
  // с названной причиной, а не отказ вьюпорта.
  try {
    // Сетка — контекст валидации парного документа: карта воды адресует её
    // клетки (REND-35). Неразобранный конфиг делает её НЕИЗВЕСТНОЙ, а не
    // отсутствующей: парный слой от поломки сим-документа не гаснет (PRES-4).
    decorations = decorationsOf(input, terrain);
  } catch (error) {
    reasons.push(message(error));
  }

  // Сравнения сеток кривизны и террейна здесь нет намеренно: это отношение
  // между двумя документами, и правило для него одно — `editor.curvatureGrid`
  // слоя валидации (ED-11). Кадр его не повторяет: вторая реализация правила,
  // у которого есть источник, расходится с ним по определению (ED-1, CORE-3).
  const sections = sectionsOf(input, terrain);
  return {
    grid,
    curvature,
    placements,
    decorations,
    ...(sections.lighting === undefined ? {} : { lighting: sections.lighting }),
    ...(sections.postprocess === undefined ? {} : { postprocess: sections.postprocess }),
    ...(sections.water === undefined ? {} : { water: sections.water }),
    visuals: input.visuals ?? null,
    failure: reasons.length === 0 ? null : reasons.join('; '),
  };
}
