/**
 * Реестр ручек качества и контроллер, раздающий их значения подсистемам
 * (`render-quality` QUAL-1, QUAL-3; design D1, D2, D3).
 *
 * ## Механизм, а не политика
 *
 * Движок публикует РУЧКИ — объявленные подсистемами стоимостные оси картинки
 * (`types.ts`: `QualityKnob`, `QualityDeclaration`). Уровни качества
 * («производительность», «баланс», «ультра») — ДАННЫЕ приложения игры: документ
 * «имя ручки → значение». Имён пресетов этот код не знает и знать не должен
 * (QUAL-1): контроллеру дают документ, а не название.
 *
 * ## Реестр собирается, а не перечисляется (design D1)
 *
 * Центрального enum'а ручек нет. Контроллер подписывается на регистрации
 * подсистем сцены (`PresentationStage.watchRegistrations`) и складывает реестр
 * из деклараций: подсистема без декларации в реестре не появляется, и это видно
 * в ревью её регистрации, а не выясняется на слабом устройстве. Обратная
 * сторона того же выбора — валидация состава документа возможна только против
 * СОБРАННОГО реестра: `validateQualityPreset` вызывают, когда сцена собрана.
 *
 * ## Применение — событиями, не кадром
 *
 * Значения уезжают подсистеме в двух точках: при её регистрации (поздняя
 * регистрация получает ТЕКУЩИЕ значения) и при смене пресета в рантайме.
 * Пересборки рендера смена не требует — подсистема применяет значения на живых
 * объектах, как туман применяет свой конфиг (FOW-10). Кадрового пути у
 * контроллера нет вовсе, и аллокаций на кадр он не делает: аллокационная
 * дисциплина кадрового пути ограничивает кадры, а смена пресета — событие.
 *
 * ## Чего контроллер не касается
 *
 * Симуляции (QUAL-2): ни одно значение отсюда не доходит до мира — все они
 * живут в подсистемах рендера, читающих `TickView` и ничего не пишущих. Состав
 * доставленной информации задаёт фильтр снапшота (`netcode` NET-12), а
 * консервативность видимого круга — маска тумана (FOW-9) при ЛЮБОМ действующем
 * разрешении.
 */
import type {
  QualityDeclaration,
  QualityKnob,
  QualityPreset,
  QualityValue,
  QualityValues,
  RenderSubsystem,
} from './types.js';
// Только тип: контроллер сцену не строит, он на неё подписывается.
import type { PresentationStage } from './stage.js';

/** Пустой документ: пресет не задан — все ручки на своих умолчаниях (QUAL-1). */
const EMPTY_PRESET: QualityPreset = Object.freeze({});

// ------------------------------------------------------------- валидация

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'массив';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Как значение показывается в отказе: число и флаг как есть, строка — в кавычках. */
function shown(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return `"${value}"`;
  return typeName(value);
}

/**
 * Одно значение против объявления ручки. Отказ АДРЕСНЫЙ (QUAL-1): он называет
 * ручку и то, чего от неё ждали, — правка документа пресета не должна
 * превращаться в угадывание, какое из десяти чисел не подошло.
 */
function checkValue(knob: QualityKnob, value: unknown, errors: string[]): void {
  const allowed = knob.values;
  if (allowed !== undefined) {
    if (!allowed.includes(value as QualityValue)) {
      errors.push(
        `${knob.name}: ожидалось одно из значений ${allowed.map(shown).join(' | ')}, получено ${shown(value)}`,
      );
    }
    return;
  }
  const min = knob.min ?? Number.NEGATIVE_INFINITY;
  const max = knob.max ?? Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(
      `${knob.name}: ожидалось конечное число из [${String(min)}, ${String(max)}], получено ${shown(value)}`,
    );
  }
}

/**
 * Значения тех ручек документа, что реестру УЖЕ известны. Отдельно от проверки
 * состава: подсистема вправе зарегистрироваться позже применения пресета, и её
 * ручки до этого момента не «неизвестные», а ещё не объявленные.
 */
function checkKnown(
  preset: QualityPreset,
  knobs: Iterable<QualityKnob>,
  errors: string[],
): void {
  for (const knob of knobs) {
    const value = preset[knob.name];
    // Отсутствие значения — документированное умолчание (QUAL-1), а не ошибка.
    if (value === undefined) continue;
    checkValue(knob, value, errors);
  }
}

/** Владелец ручки — часть имени до первой точки (`fog.maskResolution` → `fog`). */
function ownerOf(name: string): string {
  const at = name.indexOf('.');
  return at <= 0 ? '' : name.slice(0, at);
}

/**
 * Валидация документа пресета против собранного реестра (QUAL-1, design D1).
 * Состав ЗАКРЫТ: неизвестная реестру ручка отвергается адресно — с её именем, —
 * а не игнорируется молча; опечатка в имени иначе стоила бы ровно того, ради
 * чего ручка и заводилась. Отсутствующая ручка ошибкой не является: у неё есть
 * документированное умолчание.
 *
 * `declarable` — ОБЪЯВЛЯЕМЫЕ сборкой подсистемы-владельцы (QUAL-1): те, которые
 * она умеет построить, но на этой сцене могла и не построить. Ручка такого
 * владельца принимается тогда и только тогда, когда владелец НЕ ПОСТРОЕН — ни
 * одной его ручки в реестре нет; построенный владелец знает свои имена, и
 * неизвестное среди них — опечатка, а не ненайденная подсистема. Значение
 * принятой ручки проверит регистрация её подсистемы (`QualityController`).
 *
 * Перечень называет ВЛАДЕЛЬЦЕВ, а не имена ручек: имя ручки принадлежит движку,
 * и сборка, перечисляющая имена, завела бы второй их список — он расходился бы с
 * первым молча, стоило подсистеме объявить новую ручку.
 *
 * Ошибки собираются все разом, как у presentation-документа (PRES-2): чинить
 * документ по одной ошибке за прогон — не работа.
 */
export function validateQualityPreset(
  doc: unknown,
  knobs: readonly QualityKnob[],
  declarable: readonly string[] = [],
): { ok: true; preset: QualityPreset } | { ok: false; errors: string[] } {
  if (!isRecord(doc)) {
    return {
      ok: false,
      errors: [`пресет качества: ожидался объект значений ручек (QUAL-1), получено ${typeName(doc)}`],
    };
  }
  const known = new Map(knobs.map((knob) => [knob.name, knob]));
  const built = new Set(knobs.map((knob) => ownerOf(knob.name)));
  const declared = new Set(declarable);
  const names = knobs.length === 0 ? 'ни одной' : knobs.map((knob) => knob.name).join(', ');
  const errors: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    const knob = known.get(key);
    if (knob === undefined) {
      const owner = ownerOf(key);
      // Владелец объявлен сборкой и на этой сцене не построен: его ручка ждёт
      // его регистрации, а не отвергается вместе со всем документом (QUAL-1).
      if (owner !== '' && declared.has(owner) && !built.has(owner)) continue;
      errors.push(`${key}: неизвестная ручка качества — реестр её не объявлял (объявлены: ${names})`);
      continue;
    }
    checkValue(knob, value, errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, preset: doc as QualityPreset };
}

// ------------------------------------------------- ручки хоста кадра (QUAL-5)

/**
 * Масштаб буфера отрисовки (QUAL-5) — ручка, у которой владельца-подсистемы нет
 * и быть не может: буфер задаёт тот, кто зовёт `setPixelRatio`/`setSize`, то
 * есть СБОРКА, а подсистемам кадр приходит уже нужного размера и о его масштабе
 * они не знают вовсе.
 *
 * Имя принадлежит движку, а не приложению: второй его список в коде сборки
 * разошёлся бы с первым молча (то же основание, что у перечня объявляемых
 * владельцев, QUAL-1).
 */
export const FRAME_RENDER_SCALE = 'frame.renderScale';

/** Владелец ручек кадра — хост, а не подсистема: неймспейс тот же механизм. */
export const FRAME_KNOB_OWNER = 'frame';

/**
 * Границы масштаба. Ниже четверти кадр перестаёт быть кадром — это уже не
 * рычаг производительности, а другая картинка; выше четырёх не бывает плотности
 * ни у одного экрана, и потолок там ничего не ограничивает.
 */
const MIN_RENDER_SCALE = 0.25;
const MAX_RENDER_SCALE = 4;

/**
 * Объявление ручки масштаба (QUAL-5). Семантика — ПОТОЛОК над плотностью
 * пикселей устройства: умолчание «потолка нет» (бесконечность) оставляет кадр
 * тем же, каким сборка рисовала его до появления ручки.
 */
export function frameScaleKnob(): QualityKnob {
  return {
    name: FRAME_RENDER_SCALE,
    cost: 'пиксели буфера отрисовки: работа КАЖДОГО прохода кадра — и сцены, и пост-обработки, и маски тумана — растёт квадратом масштаба',
    semantics: 'ceiling',
    default: Number.POSITIVE_INFINITY,
    min: MIN_RENDER_SCALE,
    max: MAX_RENDER_SCALE,
  };
}

/**
 * Декларация хоста кадра одной функцией (QUAL-5): сборке остаётся сказать, КУДА
 * ехать значениям, а из чего состоит объявление — знает движок. Собранная
 * сборкой запись была бы вторым списком имён и разошлась бы с первым молча.
 */
export function frameKnobs(): QualityDeclaration {
  return { subsystem: FRAME_KNOB_OWNER, knobs: [frameScaleKnob()] };
}

/**
 * Действующий масштаб буфера (QUAL-5): `min(плотность устройства, потолок
 * сборки, значение ручки)`. Потолок сборки остаётся у сборки — это её граница
 * разумного (буфер, кратный плотности дорогого экрана), а не политика уровня
 * качества.
 *
 * Функция живёт здесь, а не в приложении, по тому же основанию, что имя ручки:
 * иначе демо и вьюпорт редактора считали бы одно и то же число двумя копиями
 * формулы, и разошлись бы они молча (`editor` ED-1).
 */
export function resolveRenderScale(values: QualityValues, devicePixels: number, cap: number): number {
  const knob = values.get(FRAME_RENDER_SCALE);
  const ceiling = typeof knob === 'number' && Number.isFinite(knob) ? knob : Number.POSITIVE_INFINITY;
  return Math.max(MIN_RENDER_SCALE, Math.min(devicePixels, cap, ceiling));
}

// ------------------------------------------------------------ контроллер

/**
 * Декларация и получатель её значений — пара, по которой считается доставка.
 *
 * Получатель — ФУНКЦИЯ, а не подсистема: ручку объявляет и хост кадра (QUAL-5),
 * у которого точки `applyQuality` нет вовсе. Разница между двумя входами в
 * реестр этим и исчерпывается — всё остальное (неймспейс, уникальность имени,
 * немедленная выдача значений, повторная на смене пресета) у них общее.
 */
interface Attached {
  readonly declaration: QualityDeclaration;
  readonly apply: (values: QualityValues) => void;
}

/**
 * Контроллер качества поверх `PresentationStage` (design D2). Держит текущий
 * документ пресета и раздаёт значения подсистемам; имён пресетов не знает.
 */
export class QualityController {
  private readonly attached: Attached[] = [];
  /** Реестр: имя ручки → её объявление. Собран из деклараций (design D1). */
  private readonly registry = new Map<string, QualityKnob>();
  private document: QualityPreset;

  constructor(stage: PresentationStage, preset: QualityPreset = EMPTY_PRESET) {
    this.document = preset;
    // Подписка сразу отдаёт уже зарегистрированные подсистемы, а дальше зовётся
    // на каждую новую: ранняя и поздняя регистрация неразличимы (QUAL-1).
    stage.watchRegistrations((subsystem) => {
      this.attach(subsystem);
    });
  }

  /** Собранный реестр — вход валидации документа и отчёта (QUAL-1). */
  get knobs(): readonly QualityKnob[] {
    return [...this.registry.values()];
  }

  /** Применённый сейчас документ пресета. */
  get preset(): QualityPreset {
    return this.document;
  }

  /**
   * Действующие значения всех объявленных ручек — отчёт (design Risks): по нему
   * видно, что сцена говорит 8, а картинка строится на 4, и это пресет, а не
   * потерянное поле документа.
   */
  effective(): ReadonlyMap<string, QualityValue> {
    const values = new Map<string, QualityValue>();
    for (const knob of this.registry.values()) values.set(knob.name, this.valueOf(knob));
    return values;
  }

  /**
   * Смена пресета в рантайме (QUAL-1, design D2): значения уезжают всем
   * подсистемам заново, пересборки рендера нет. Значения известных реестру ручек
   * проверяются здесь же — негодное число отвергается адресно и документ не
   * применяется ни к одной подсистеме (иначе половина сцены жила бы по новому
   * пресету, а половина по старому).
   *
   * Состав документа (неизвестная ручка) проверяет `validateQualityPreset`
   * против собранного реестра: здесь этой проверки нет намеренно — подсистема
   * вправе зарегистрироваться позже, и её ручка до того «неизвестна» только по
   * порядку сборки.
   */
  apply(preset: QualityPreset): void {
    const errors: string[] = [];
    checkKnown(preset, this.registry.values(), errors);
    if (errors.length > 0) throw new Error(refusal(errors));
    this.document = preset;
    for (const entry of this.attached) this.push(entry);
  }

  /** Текущий документ против собранного реестра (QUAL-1) — состав и значения. */
  validate(): { ok: true; preset: QualityPreset } | { ok: false; errors: string[] } {
    return validateQualityPreset(this.document, this.knobs);
  }

  /**
   * Документ против собранного реестра, ДОПОЛНЕННОГО объявляемыми сборкой
   * подсистемами-владельцами (QUAL-1). Сцена без тумана не повод отвергнуть
   * документ, написанный про сборку, которая туман умеет: ручка непостроенного
   * владельца дождётся его регистрации, а её значение проверит она же.
   *
   * Перечень — данные СБОРКИ ИГРЫ: «эту подсистему я умею построить» знает тот,
   * кто её строит, и вывести это из реестра нельзя по определению — в реестре
   * лежит построенное.
   */
  validateAgainst(
    declarable: readonly string[],
    doc: unknown = this.document,
  ): { ok: true; preset: QualityPreset } | { ok: false; errors: string[] } {
    return validateQualityPreset(doc, this.knobs, declarable);
  }

  /**
   * Подсистема пришла в сцену: её декларация складывается в реестр, и она
   * немедленно получает текущие значения своих ручек.
   */
  private attach(subsystem: RenderSubsystem): void {
    const declaration = subsystem.quality?.();
    if (declaration === undefined) return;
    this.bind(declaration, (values) => {
      subsystem.applyQuality?.(values);
    });
  }

  /**
   * Декларация хоста кадра (QUAL-5): сборка объявляет ось, которой не владеет
   * ни одна подсистема, — масштаб буфера отрисовки, — и получает её значения
   * функцией. Путь тот же, что у подсистемы: неймспейс владельца, уникальность
   * имени, значения сразу и заново при смене пресета.
   */
  declareHost(declaration: QualityDeclaration, apply: (values: QualityValues) => void): void {
    this.bind(declaration, apply);
  }

  /**
   * Общий вход в реестр: объявление плюс немедленная выдача значений.
   *
   * Имя не `declare`: репозиторий гоняет TypeScript в Node снятием типов, а
   * `declare` там — модификатор объявления, и метод с таким именем ломает
   * разбор файла (`bin/tsHook.mjs`, CLI-8). Ловится это только запуском бинаря,
   * не тестами пакета.
   */
  private bind(declaration: QualityDeclaration, apply: (values: QualityValues) => void): void {
    this.register(declaration);
    const entry: Attached = { declaration, apply };
    this.attached.push(entry);
    this.push(entry);
  }

  /** Декларация в реестр: неймспейс, непустота и уникальность имён (QUAL-1, QUAL-3). */
  private register(declaration: QualityDeclaration): void {
    const owner = declaration.subsystem;
    if (declaration.knobs.length === 0 && declaration.constantCost === undefined) {
      throw new Error(
        `QualityController: подсистема "${owner}" объявила пустой список ручек, не назвав причину — ` +
          'константность стоимости объявляется явно (QUAL-3)',
      );
    }
    // Декларация принимается ЦЕЛИКОМ или не принимается вовсе: до всех проверок
    // ручки копятся в локальной карте и в реестр не попадают. Иначе отказ на
    // второй ручке оставлял бы первую в реестре — ручку подсистемы, которой в
    // сцене нет, потому что её регистрация оборвалась исключением. Такая ручка
    // не досталась бы никому (в `attached` пары нет) и при этом закрывала бы
    // своё имя от следующего владельца.
    const declared = new Map<string, QualityKnob>();
    const errors: string[] = [];
    for (const knob of declaration.knobs) {
      if (!knob.name.startsWith(`${owner}.`)) {
        errors.push(`ручка "${knob.name}" не в неймспейсе подсистемы "${owner}" (ожидалось "${owner}.<имя>")`);
        continue;
      }
      // Столкновение — и с уже собранным реестром, и с соседней ручкой той же
      // декларации: два владельца одного имени внутри одной подсистемы — тот же
      // дефект, что и между подсистемами.
      if (this.registry.has(knob.name) || declared.has(knob.name)) {
        errors.push(`ручка "${knob.name}" уже объявлена — двух владельцев у оси стоимости не бывает`);
        continue;
      }
      declared.set(knob.name, knob);
    }
    if (errors.length > 0) throw new Error(refusal(errors));
    // Значения документа, относящиеся к только что объявленным ручкам, до этой
    // минуты проверить было не по чему: реестр их не знал.
    const values: string[] = [];
    checkKnown(this.document, declaration.knobs, values);
    if (values.length > 0) throw new Error(refusal(values));
    // Все проверки прошли — только теперь декларация въезжает в реестр.
    for (const [name, knob] of declared) this.registry.set(name, knob);
  }

  /**
   * Значения ручек одной подсистемы — только её собственных (design D2).
   * Словарь строится на СОБЫТИЕ (регистрация, смена пресета), а не на кадр:
   * кадрового пути у контроллера нет вовсе.
   */
  private push(entry: Attached): void {
    const values = new Map<string, QualityValue>();
    for (const knob of entry.declaration.knobs) values.set(knob.name, this.valueOf(knob));
    entry.apply(values);
  }

  /** Значение ручки: из документа, а нет его — документированное умолчание (QUAL-1). */
  private valueOf(knob: QualityKnob): QualityValue {
    return this.document[knob.name] ?? knob.default;
  }
}

function refusal(errors: string[]): string {
  return `QualityController: пресет качества отвергнут — ${errors.join('; ')}`;
}
