/**
 * Манифест визуалов (ASSET-6): data-driven JSON-документ «sim-идентификатор
 * сущности → визуал», отдельный от конфига сцены. Ссылки направлены только из
 * манифеста в sim-идентификаторы (имена prefab'ов); sim-описания сущностей
 * путей к presentation-ассетам не содержат. Правка манифеста не меняет
 * `worldInit`, снапшоты, golden-файлы и совместимость реплеев.
 *
 * Манифест — политика, не механизм: какая модель у юнита, какой клип на какое
 * действие, какие лимиты у поворота головы — решает этот JSON, а не код.
 *
 * Разделов записей два (ASSET-9): `entities` ключуется sim-идентификатором, а
 * `decorations` — ключом вида, за которым в симуляции нет ничего. Состав записи
 * у них общий, пространство ключей — тоже одно, и разрешает ключ в запись одна
 * функция (`resolveVisual`), а не каждый потребитель по-своему.
 *
 * РАСКЛАДКА ПО МОДУЛЯМ. Здесь — состав документа и разрешение ключа в запись,
 * то есть что манифест значит для потребителя. Какой документ формат принимает
 * — `manifestValidate.ts`; поля, общие у разных записей, — `manifestFields.ts`;
 * самостоятельные форматы внутри документа — своими модулями: секции камеры
 * (ASSET-8, ASSET-10) `cameraEffects.ts`, секции эффектов и частиц (REND-23,
 * REND-24) `visualSections.ts`, блок света записи (ASSET-16) `visualLight.ts`.
 */
import { resolveLightBlock, type ResolvedVisualLight, type VisualLight } from './visualLight.js';
import type { CameraConfigSection, CameraEffectsSection } from './cameraEffects.js';
import type { TerrainVisualSection } from './visualSections.js';
import type { AssetKind } from './types.js';

/** Ключ — sim-идентификатор (имя prefab'а/архетипа). */
export interface VisualManifest {
  entities: Record<string, EntityVisual>;
  /**
   * Раздел decoration-видов (ASSET-9): записи того же состава, что записи
   * сущностей, но за ключом которых в симуляции нет ничего — ни prefab'а, ни
   * архетипа. Отдельный раздел, а не ключи в `entities`, потому что `entities`
   * ключуется sim-идентификатором, а ED-19 требует подсвечивать «запись
   * манифеста без prefab'а» как рассинхронизацию пары: попади decoration-виды
   * туда, каждый из них стал бы находкой валидации.
   *
   * Ключи обоих разделов лежат в ОДНОМ пространстве (ASSET-9): потребитель
   * разрешает визуальный ключ в запись одним способом (`resolveVisual`), а два
   * раздела с пересекающимися именами сделали бы ответ зависящим от порядка
   * просмотра. Поэтому пересечение имён — ошибка валидации манифеста.
   */
  decorations?: Record<string, DecorationVisual>;
  /** Дефолт наклона по поверхности для записей без своего surfaceAlign (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Presentation-данные террейна арены: рельеф (ASSET-7) и текстурирование (ASSET-15). */
  terrain?: TerrainVisualSection;
  /** Секция транзиентных эффектов сцены (REND-23); потребитель — подсистема эффектов. */
  effects?: VisualEffectsSection;
  /** Секция эмиттеров частиц (ASSET-14, REND-24); потребитель — подсистема частиц. */
  particles?: VisualParticlesSection;
  /** Секция эффектов камеры (ASSET-8); потребитель — `camera` CAM-6. */
  cameraEffects?: CameraEffectsSection;
  /** Секция конфига камеры (ASSET-10); потребитель — конвейер `camera` CAM-1. */
  cameraConfig?: CameraConfigSection;
}

/** Запись визуального ключа как она есть: модельная либо эмиттерная (ASSET-14). */
function visualEntry(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
  key: string,
): DecorationVisual | undefined {
  return manifest.entities[key] ?? manifest.decorations?.[key];
}

/**
 * Модельная запись визуального ключа — одно место разрешения на оба раздела
 * (ASSET-9). Потребители зовут его, а не читают раздел сами: пространство ключей
 * одно, и выбор раздела не должен становиться решением каждого вызывающего.
 *
 * Порядок просмотра здесь ни на что не влияет: пересечение имён отвергается
 * валидацией манифеста, поэтому ключ разрешается не более чем в одну запись.
 *
 * Эмиттерный вид (ASSET-14) сюда не приходит: его изображение — частицы, а не
 * инстанс модели (`rendering` REND-24), и разрешает его `resolveVisualEmitter`.
 * Два ответа на один ключ — не два пространства имён, а разделение по РОДУ
 * записи: подсистема моделей не должна получать вид, который ей нечем рисовать,
 * и не должна принимать его за отсутствие записи (ASSET-4 — заглушка означает
 * «ассет не доехал», а не «рисует не я»).
 *
 * Пустой ответ здесь сам по себе не означает отсутствия записи: поводов у него
 * три, и все они — чужое изображение (`rendering` REND-37). Кто вправе заявить
 * вид, знает потребитель, а не этот резолвер.
 */
export function resolveVisual(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
  key: string,
): EntityVisual | undefined {
  const entry = visualEntry(manifest, key);
  return entry === undefined || isEmitterVisual(entry) ? undefined : entry;
}

/**
 * Локальный источник записи визуального ключа (ASSET-16) — разобранный блок
 * `light` в величинах рендера; `null` — записи с таким ключом нет либо света
 * она не несёт.
 *
 * Одно место разрешения на ОБА рода записи (ASSET-14) и оба раздела (ASSET-9):
 * свет — свойство ЗАПИСИ, а не её изображения, и факел, который рисуется
 * частицами (REND-24), несёт его наравне со статуей. Потребитель у ответа один
 * — подсистема, владеющая инстансами записи (`rendering` REND-33), — и
 * спрашивать род записи ей для этого не нужно.
 */
export function resolveVisualLight(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
  key: string,
): ResolvedVisualLight | null {
  return resolveLightBlock(visualEntry(manifest, key)?.light);
}

/**
 * Эмиттерная запись визуального ключа (ASSET-14): вид, изображение которого —
 * частицы (факел, костёр). Пространство ключей то же самое, что у модельных
 * видов, и размещение (`presentation-scene` PRES-2) ссылается на неё тем же
 * полем `visual`.
 */
export function resolveVisualEmitter(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
  key: string,
): EmitterVisual | undefined {
  const entry = visualEntry(manifest, key);
  return entry !== undefined && isEmitterVisual(entry) ? entry : undefined;
}

/** Эмиттерный ли это вид: изображение — частицы, а не модель (ASSET-14). */
export function isEmitterVisual(visual: DecorationVisual): visual is EmitterVisual {
  return visual.effect !== undefined;
}

/**
 * Эффект-оболочка визуального типа (REND-23) — одно место разрешения на всех
 * потребителей: подсистема эффектов рисует по нему, а подсистема моделей по
 * нему же понимает, что сущность рисуется НЕ моделью и заглушка ей не нужна
 * (ASSET-4 — заглушка означает «ассет не доехал», а не «записи нет»; правило
 * целиком — `rendering` REND-37).
 */
export function resolveEffectByKind(
  manifest: Pick<VisualManifest, 'effects'>,
  kind: string,
): VisualEffect | undefined {
  return manifest.effects?.byKind?.[kind];
}

/**
 * Эффект-оболочка доставленного состояния сущности (REND-23): сфера щита живёт,
 * пока состояние доставляется, и исчезает вместе с ним.
 */
export function resolveEffectByState(
  manifest: Pick<VisualManifest, 'effects'>,
  state: string,
): VisualEffect | undefined {
  return manifest.effects?.byState?.[state];
}

/** Эффект-вспышка типа события (REND-23, REND-4: реакция на событие — данные). */
export function resolveEffectByEvent(
  manifest: Pick<VisualManifest, 'effects'>,
  event: string,
): VisualEffect | undefined {
  return manifest.effects?.byEvent?.[event];
}

/**
 * Эмиттер визуального типа (ASSET-14, `rendering` REND-24): эмиттер живёт, пока
 * сущность этого типа есть в доставленном состоянии.
 *
 * Потребителя у ответа два, как и у записи эффекта: подсистема частиц рисует по
 * нему, а подсистема моделей по нему же понимает, что вид рисует не она, — и
 * заглушки ему не ставит (`rendering` REND-37).
 *
 * Разрешение идёт по СВОЕЙ секции, без просмотра секции транзиентных эффектов:
 * запись принадлежит ровно одной из двух (REND-23 в новой редакции), и
 * потребитель одной секции не должен зависеть от содержимого другой.
 */
export function resolveParticlesByKind(
  manifest: Pick<VisualManifest, 'particles'>,
  kind: string,
): VisualEmitter | undefined {
  return manifest.particles?.byKind?.[kind];
}

/**
 * Эмиттер доставленного состояния сущности (REND-24): частицы дебафа живут,
 * пока состояние доставляется, и гаснут вместе с ним.
 */
export function resolveParticlesByState(
  manifest: Pick<VisualManifest, 'particles'>,
  state: string,
): VisualEmitter | undefined {
  return manifest.particles?.byState?.[state];
}

/** Эмиттер-one-shot типа события тика (REND-24, REND-4). */
export function resolveParticlesByEvent(
  manifest: Pick<VisualManifest, 'particles'>,
  event: string,
): VisualEmitter | undefined {
  return manifest.particles?.byEvent?.[event];
}

/**
 * Ссылка манифеста на ассет дерева контента: путь внутри документа, сам ID
 * (ASSET-2) и вид ассета, которым ID грузится (ASSET-3). Путь — адрес находки
 * валидации (`editor` ED-30), поэтому он поэлементный, а не строкой.
 *
 * Вид назван тем же словарём, что у реестра загрузчиков (`AssetKind`), а не
 * своим перечислением: спрашивающему, который ссылку РАЗБИРАЕТ, нужен именно
 * загрузчик, и второе имя одного и того же вида разошлось бы с реестром молча.
 */
export interface VisualAssetRef {
  readonly path: readonly (string | number)[];
  readonly asset: string;
  readonly kind: AssetKind;
}

/**
 * Все ссылки манифеста на ассеты дерева контента — модели, текстуры скинов,
 * эмиттерные документы (ASSET-14) и карта кривизны арены (ASSET-7).
 *
 * Живёт у владельца формата, а не у спрашивающего: где в записи лежит ID
 * ассета, знает манифест (ASSET-6), и второй перечень этих мест разошёлся бы с
 * форматом молча при первом же новом поле — ровно тем дефектом, который
 * `editor` ED-1 запрещает заводить редактору. Спрашивающих двое, и оба зовут
 * именно это: правило редактора, подсвечивающее ссылку в никуда до диска
 * (ED-14), и проверка контента репозитория (`integration-ts`), которая
 * отбирает ссылки нужного ей вида и разбирает документы за ними.
 *
 * Порядок обхода устойчив — разделы, затем секция эмиттеров, затем террейн, а
 * внутри раздела порядок ключей документа: находки валидации сортируются по
 * своему пути, но проверка, сверяющая список целиком, не должна зависеть от
 * порядка перечисления объекта.
 */
export function manifestAssetRefs(
  manifest: Pick<VisualManifest, 'entities' | 'decorations' | 'particles' | 'terrain'>,
): readonly VisualAssetRef[] {
  const refs: VisualAssetRef[] = [];
  const entryRefs = (section: 'entities' | 'decorations', key: string, entry: DecorationVisual): void => {
    if (isEmitterVisual(entry)) {
      refs.push({ path: [section, key, 'effect'], asset: entry.effect, kind: 'particle-effect' });
    } else {
      refs.push({ path: [section, key, 'model'], asset: entry.model, kind: 'model' });
    }
    for (const [skin, slots] of Object.entries(entry.skins ?? {})) {
      for (const [slot, texture] of Object.entries(slots)) {
        refs.push({ path: [section, key, 'skins', skin, slot], asset: texture, kind: 'texture' });
      }
    }
  };
  for (const [key, entry] of Object.entries(manifest.entities)) entryRefs('entities', key, entry);
  for (const [key, entry] of Object.entries(manifest.decorations ?? {})) {
    entryRefs('decorations', key, entry);
  }
  for (const table of ['byKind', 'byState', 'byEvent'] as const) {
    for (const [key, record] of Object.entries(manifest.particles?.[table] ?? {})) {
      refs.push({
        path: ['particles', table, key, 'effect'],
        asset: record.effect,
        kind: 'particle-effect',
      });
    }
  }
  const curvature = manifest.terrain?.curvatureMap;
  if (curvature !== undefined) {
    refs.push({ path: ['terrain', 'curvatureMap'], asset: curvature, kind: 'terrain-curvature' });
  }
  const paint = manifest.terrain?.paintMap;
  if (paint !== undefined) {
    refs.push({ path: ['terrain', 'paintMap'], asset: paint, kind: 'terrain-paint' });
  }
  const tileset = manifest.terrain?.tileset;
  if (tileset !== undefined) {
    tileset.slots.forEach((slot, index) => {
      refs.push({ path: ['terrain', 'tileset', 'slots', String(index), 'texture'], asset: slot.texture, kind: 'texture' });
    });
    if (tileset.wall !== undefined) {
      refs.push({ path: ['terrain', 'tileset', 'wall', 'texture'], asset: tileset.wall.texture, kind: 'texture' });
    }
  }
  return refs;
}

/**
 * Кто рисует вид, у которого модельной записи нет (`rendering` REND-37):
 * `'effect'` — подсистема эффектов по записи `effects.byKind` (REND-23),
 * `'particles'` — подсистема частиц по эмиттерному decoration-виду (ASSET-14)
 * либо по записи `particles.byKind` (REND-24); `null` — не рисует никто, и
 * пустой ответ `resolveVisual` означает ровно то, чем выглядит: записи о виде
 * нет (ASSET-6).
 *
 * Одно место на весь репозиторий, а не по списку у каждого спрашивающего.
 * Спрашивающих двое, и вопрос у них один: подсистема моделей решает, ставить ли
 * заглушку (REND-37 — «заглушка поверх чужого изображения врёт дважды»), а
 * правило пары редактора (`editor` ED-19) решает, называть ли prefab без записи
 * рассинхронизацией. Второй перечень секций разошёлся бы с этим молча первым же
 * источником, который заведёт новая подсистема, — а REND-37 задаёт перечень
 * ПРАВИЛОМ, и новый источник обязан войти в него сам.
 *
 * Спрашиваются ровно источники, ключуемые ВИЗУАЛЬНЫМ ТИПОМ. Таблицы `byState` и
 * `byEvent` обеих секций сюда не входят: они ключуются именем состояния и типом
 * события, вида не называют, и заглушка, зависящая от них, мигала бы вместе с
 * доставленным состоянием (REND-37).
 *
 * Порядок вопросов наблюдаемый, и секция эмиттеров стоит РАНЬШЕ секции эффектов
 * намеренно (REND-37). Ключи секций пересекаться вправе — принадлежать ровно
 * одной секции REND-23 обязывает ЗАПИСЬ, а не ключ, — и в контенте это
 * пересечение живёт: у пятна огня демо пламя рисуют частицы, а плоская оболочка
 * эффекта под ними подсвечивает зону урона по земле. Ответь этот резолвер про
 * такой вид `'effect'` — вид остался бы без объёма-прокси, то есть невыделяемым,
 * ровно за добавленное свечение.
 */
export function resolveVisualClaim(
  manifest: Pick<VisualManifest, 'entities' | 'decorations' | 'effects' | 'particles'>,
  kind: string,
): VisualClaim {
  if (resolveVisualEmitter(manifest, kind) !== undefined) return 'particles';
  if (resolveParticlesByKind(manifest, kind) !== undefined) return 'particles';
  if (resolveEffectByKind(manifest, kind) !== undefined) return 'effect';
  return null;
}

/** Подсистема, заявившая изображение вида (REND-37); `null` — не заявил никто. */
export type VisualClaim = 'effect' | 'particles' | null;

/**
 * Все визуальные ключи манифеста в одном пространстве (ASSET-9) — то, из чего
 * автор выбирает вид для размещения (`presentation-scene` PRES-2) и по чему
 * валидация редактора судит о разрешимости ссылки.
 */
export function visualKeys(
  manifest: Pick<VisualManifest, 'entities' | 'decorations'>,
): readonly string[] {
  return [...Object.keys(manifest.entities), ...Object.keys(manifest.decorations ?? {})];
}

/**
 * Секция транзиентных эффектов (`rendering` REND-23): три таблицы — эффект по
 * визуальному типу сущности (оболочка живёт, пока живёт сущность), эффект по
 * доставленному СОСТОЯНИЮ сущности (оболочка живёт, пока состояние доставляется
 * — щит) и эффект по типу reliable-события (вспышка проигрывает свою
 * длительность и исчезает).
 *
 * Пространства ключей у таблиц РАЗНЫЕ и пересекаться им не запрещено: слева
 * визуальные типы, посередине имена компонент-состояний, справа типы событий, и
 * одноимённые записи значат разное. Это не то же самое, что разделы записей
 * инстансов (ASSET-9), где ключ один и разрешается одной функцией.
 */
export interface VisualEffectsSection {
  /** Визуальный тип сущности → эффект-оболочка. */
  byKind?: Record<string, VisualEffect>;
  /**
   * Имя компоненты-состояния сущности → эффект-оболочка (REND-23: «пока жива
   * сущность И ЕЁ СОСТОЯНИЕ ЕГО ТРЕБУЕТ»). Состояния доезжают битами
   * `EntityView.states` — тем же списком `stateComponents` сборки, что кормит
   * длящиеся эффекты камеры (ASSET-8, CAM-6): второго способа назвать состояние
   * в манифесте не появляется.
   */
  byState?: Record<string, VisualEffect>;
  /** Тип события тика → эффект-вспышка. */
  byEvent?: Record<string, VisualEffect>;
}

/**
 * Запись эффекта (REND-23): примитив и его числа. Перечня примитивов и кривых
 * у модуля ассетов нет намеренно — их называет рендер, а манифест переживает
 * код: неизвестное имя подсистема пропускает с предупреждением, как и
 * неизвестный тип эффекта камеры (ASSET-8).
 */
export interface VisualEffect {
  /** Имя примитива; рендер сегодня умеет `sphere`. */
  primitive: string;
  /** Цвет в форме, которую понимает рендер (`#rrggbb`). */
  color: string;
  /** Радиус в начале жизни, мировые единицы. */
  radius: number;
  /** Радиус в конце жизни; без него радиус постоянен. */
  radiusTo?: number;
  /** Прозрачность в начале жизни, [0..1]; без неё — 1. */
  alpha?: number;
  /** Прозрачность в конце жизни; без неё альфа постоянна. */
  alphaTo?: number;
  /** Длительность вспышки, мс. У оболочки длительности нет — она живёт с сущностью. */
  durationMs?: number;
  /** Имя кривой фазы жизни; рендер сегодня умеет `linear` и `easeOut`. */
  curve?: string;
  /** Подъём центра примитива над опорной высотой, мировые единицы. */
  height?: number;
  /**
   * Вертикальное смещение записи (REND-12) — для эффекта-оболочки, который и
   * есть изображение сущности: полётная дуга снаряда живёт здесь по той же
   * причине, по какой дуга прыжка живёт в записи инстанса, — это ЕГО запись
   * манифеста. Виды смещения, к оболочке неприменимые (дуги манёвров,
   * снижение при провале), смысла не имеют, как и у записи decoration (ASSET-9).
   */
  verticalOffset?: VerticalOffset;
}

/**
 * Секция эмиттеров частиц (ASSET-14, `rendering` REND-24): те же три таблицы
 * источников, что у секции транзиентных эффектов, — по визуальному типу, по
 * имени доставленного состояния и по типу события тика. Пространства ключей
 * таблиц разные ровно по той же причине, что у `effects`.
 *
 * Секция отдельная, а не поле записи эффекта: у частиц свой ассет и свой
 * конвейер отрисовки, а запись принадлежит ровно одной из двух секций (REND-23
 * в новой редакции) — совмещённая запись заставила бы обе подсистемы читать
 * чужую секцию, чтобы понять, чья она.
 */
export interface VisualParticlesSection {
  /** Визуальный тип сущности → эмиттер. */
  byKind?: Record<string, VisualEmitter>;
  /**
   * Имя компоненты-состояния сущности → эмиттер. Словарь битов состояний — тот
   * же список `stateComponents` сборки, что кормит эффекты и камеру (REND-23,
   * `camera` CAM-6): второго способа назвать состояние в манифесте не
   * появляется (REND-24).
   */
  byState?: Record<string, VisualEmitter>;
  /** Тип события тика → one-shot-эмиттер. */
  byEvent?: Record<string, VisualEmitter>;
}

/**
 * Запись эмиттера (ASSET-14): ссылка на эмиттерный ассет плюс привязка к
 * инстансу. Состав закрыт — неизвестный ключ отвергается валидацией, а не
 * игнорируется молча.
 *
 * Числа самого эффекта (скорость, время жизни, цвет, число частиц) здесь
 * намеренно отсутствуют: они принадлежат документу эффекта, который пишет
 * внешний редактор, и второе их место сделало бы вопрос «где настоящее
 * значение» неразрешимым.
 */
export interface VisualEmitter {
  /** Asset id эмиттерного ассета (ASSET-14). */
  effect: string;
  /**
   * Имя узла-сокета модели инстанса (`rendering` REND-24): эмиттер следует позе
   * этого узла в каждом кадре (факел в руке, хвост снаряда). Без него — позиция
   * сущности, как у транзиентных эффектов (REND-23).
   */
  socket?: string;
  /** Положительный множитель масштаба эффекта; без него — 1. */
  scale?: number;
}

/**
 * Наклон инстанса по нормали визуальной поверхности (REND-10): up-вектор —
 * slerp(вертикаль, нормаль, factor); maxAngleDeg ограничивает итоговое
 * отклонение от вертикали при любом factor.
 */
export interface SurfaceAlign {
  /** 0 — всегда вертикален, 1 — перпендикулярен поверхности. */
  factor: number;
  maxAngleDeg?: number;
}

/** Дефолт REND-10: перпендикулярен поверхности, без лимита угла. */
export const DEFAULT_SURFACE_ALIGN: Readonly<SurfaceAlign> = Object.freeze({ factor: 1 });

/**
 * Вертикальное смещение инстанса (REND-12): дуги движения и снижение при
 * провале. Вертикали в симуляции нет (`locomotion` LOC-5), поэтому числа
 * художественные и живут только здесь. Все поля опциональны, отсутствие
 * означает отсутствие смещения — глобального дефолта у секции намеренно нет:
 * высота прыжка — свойство персонажа, а не мира (в отличие от наклона).
 *
 * Высота дуги называется НА ВИД манёвра (REND-12): прыжок и наземные манёвры
 * независимы, и дуга одного вида к другому не применяется. Отсутствие поля —
 * отсутствие дуги у этого вида, а не заимствование чужой высоты.
 */
export interface VerticalOffset {
  /** Максимум дуги прыжка (`Airborne`) в мировых единицах; без него дуги нет. */
  jumpArc?: number;
  /**
   * Максимум дуги наземного манёвра (`Dodge`, `Roll` — `locomotion` LOC-3).
   * Отдельное число, а не доля прыжковой высоты: перекат подпрыгивает иначе,
   * чем прыжок, и заимствование одного числа двумя видами и есть тот дефект,
   * который REND-12 запрещает.
   */
  maneuverArc?: number;
  /**
   * Максимум полётной дуги — по фазе полёта плоской формы (REND-12). Фазу
   * заполняет сборка воркера (`client-shell` SHELL-2); нет фазы — нет и дуги,
   * сколько бы ни было записано здесь.
   */
  flightArc?: number;
  /** Скорость снижения при провале, мировых единиц в секунду. */
  fallSpeed?: number;
  /** На сколько инстанс уходит вниз и там останавливается. */
  fallDepth?: number;
}

/**
 * Ярус представления инстанса (`rendering` REND-20), заданный записью явно
 * (ASSET-13). Батчевый — разделяемый батч со скиннингом по запечённым данным;
 * детальный — пер-инстансное поддерево со скелетом.
 */
export type VisualTier = 'batched' | 'detailed';

/**
 * Пороги LOD по умолчанию (ASSET-13, `rendering` REND-22): доля высоты кадра,
 * ниже которой инстанс переходит на следующий уровень цепочки. Это УМОЛЧАНИЕ
 * кода, а не политика: запись, которой числа важны, задаёт свои — художник
 * правит манифест, а не рендер.
 */
export const DEFAULT_LOD_THRESHOLDS: readonly number[] = Object.freeze([0.12, 0.05]);

/**
 * Ярус записи (ASSET-13): явное поле записи → умолчание. Умолчание — батчевый,
 * кроме записей с настроенным процедурным контролем костей (`rendering`
 * REND-5): им нужен настоящий скелет, и батчевого яруса они не переживут.
 *
 * Один ответ на весь репозиторий: выбор яруса не должен становиться решением
 * каждого потребителя — иначе рендер и редактор разошлись бы в том, что автор
 * увидит в кадре.
 */
export function resolveVisualTier(visual: EntityVisual | undefined): VisualTier {
  if (visual?.tier !== undefined) return visual.tier;
  return visual?.boneControls === undefined ? 'batched' : 'detailed';
}

/** Пороги LOD записи: свои → умолчание кода (ASSET-13). */
export function resolveLodThresholds(visual: EntityVisual | undefined): readonly number[] {
  return visual?.lodThresholds ?? DEFAULT_LOD_THRESHOLDS;
}

/** Параметры наклона записи: свои → дефолт манифеста → дефолт спеки (ASSET-6). */
export function resolveSurfaceAlign(
  manifest: Pick<VisualManifest, 'surfaceAlign'>,
  visual: EntityVisual | undefined,
): SurfaceAlign {
  return visual?.surfaceAlign ?? manifest.surfaceAlign ?? DEFAULT_SURFACE_ALIGN;
}

export interface EntityVisual {
  /** Asset id модели. */
  model: string;
  /**
   * Различитель рода записи (ASSET-14): у модельного вида эмиттерного ассета
   * нет. Поле объявлено ради того, чтобы `visual.effect` был законным вопросом
   * к любой записи вида, а не ошибкой типов на одной из ветвей объединения.
   */
  effect?: undefined;
  /** Мировая высота юнита; по умолчанию 1. */
  scale?: number;
  /**
   * Куда смотрит МОДЕЛЬ в канонических осях модуля — угол в градусах против
   * часовой стрелки от `+X` (REND-13). Это описание самой модели, а не поправка
   * к курсу: поправку рендер выводит сам.
   *
   * Перёд — свойство авторинга модели, а не системы координат: канонические оси
   * (ASSET-5) фиксируют, где верх и какова единица длины, но не то, куда
   * повёрнуто лицо, и вывести это из файла нельзя. Поэтому значение живёт в
   * записи, а не одним числом на всех: модели разных форматов с разным передом
   * сосуществуют в одной сцене.
   *
   * Примеры: у моделей MDX лицо вдоль `+X` — это `0` (и умолчание при
   * отсутствии поля); у glTF-модели, чьё лицо смотрит вдоль `−Y`, это `-90`.
   */
  facingDeg?: number;
  defaultSkin?: string;
  /** Имя скина → (номер textureSlot как строка → asset id текстуры). */
  skins?: Record<string, Record<string, string>>;
  /** Состояние рендера ('idle', 'move', 'dodge', 'roll', 'jump', 'fall') → подстрока имени клипа; имя события → подстрока имени клипа (REND-4). */
  animations?: { states?: Record<string, string>; events?: Record<string, string> };
  /** Роль ('torso', 'head') → параметры процедурного контроля кости (REND-5). */
  boneControls?: Record<string, { bone: string; maxYawDeg: number; smoothing: number }>;
  /** Индексы частей модели (`NormalizedMesh.partId`), исключаемых из рендера. */
  hiddenParts?: number[];
  /** Наклон по нормали визуальной поверхности; без него — дефолт манифеста (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Дуга прыжка и снижение при провале (REND-12); без секции — смещения нет. */
  verticalOffset?: VerticalOffset;
  /**
   * Ярус представления инстанса (ASSET-13, `rendering` REND-20). Без поля —
   * умолчание `resolveVisualTier`: батчевый, кроме записей с `boneControls`.
   * Поле — политика вида: художник переводит штучную крупную модель в детальный
   * ярус, не правя код рендера.
   */
  tier?: VisualTier;
  /**
   * Пороги переключения LOD-цепочки (ASSET-13, `rendering` REND-22): доли
   * высоты кадра, строго убывающие. Без поля — умолчания
   * `DEFAULT_LOD_THRESHOLDS`; модель без цепочки уровней порогов не замечает.
   */
  lodThresholds?: number[];
  /**
   * Локальный источник света, который несёт каждый инстанс записи (ASSET-16,
   * `rendering` REND-33): факел светит с чаши, кристалл — из середины. Без поля
   * инстансы записи света не несут, и наличие поля не меняет ни `worldInit`, ни
   * снапшот (ASSET-1). Состав блока и его единицы — `visualLight.ts`.
   */
  light?: VisualLight;
}

/**
 * Эмиттерный вид (ASSET-14): запись раздела decoration-видов, изображение
 * которой — частицы, а не инстанс модели (`rendering` REND-24). Состав тот же,
 * что у модельного вида, с одной подменой: вместо `model` — `effect`.
 *
 * Поля, применимые только к модели (скины, клипы, кости, наклон, ярус), на
 * эмиттерном виде смысла не имеют, но ошибкой не считаются — по тому же
 * основанию, по какому их не запрещает и модельный decoration-вид (ASSET-9):
 * запись одного состава на оба рода дешевле, чем два состава.
 */
export interface EmitterVisual extends Omit<EntityVisual, 'model' | 'effect'> {
  /** Asset id эмиттерного ассета — изображение вида (ASSET-14). */
  effect: string;
  /** Модели у эмиттерного вида нет: поле отсутствует — оно и различает род записи. */
  model?: undefined;
}

/**
 * Запись визуального ключа любого рода (ASSET-9, ASSET-14). Раздел `entities`
 * ключуется sim-идентификатором и держит только модельные виды: эмиттер
 * СУЩНОСТИ — запись секции `particles` (REND-24), а не подмена её модели.
 */
export type DecorationVisual = EntityVisual | EmitterVisual;
