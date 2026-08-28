/**
 * Секция `lighting` парного presentation-документа (`presentation-scene` PRES-2,
 * `rendering` REND-29) — её состав и её валидация.
 *
 * Живёт отдельно от документа (`presentation.ts`) по размеру и по предмету:
 * документ описывает СЛОЙ сцены (записи decoration, секции и правила имени
 * пары), а здесь — один самостоятельный формат со своими уровнями вложенности,
 * подсекцией цикла времени суток (REND-32) и своими адресами находок. Читаются
 * они по отдельности, и правятся по отдельности тоже.
 *
 * Границы те же, что у всего документа: здесь проверяется ФОРМА данных, а
 * политика картинки — сами умолчания, смысл интерполяции, длина перехода по
 * умолчанию — живёт у подсистемы освещения рендера (`render-ts`,
 * `lighting/config.ts`). На симуляцию секция не влияет ни байтом (PRES-4).
 *
 * Примитивы валидации (подсекция, числовое поле, цвет) — общие
 * на все секции документа и живут в `presentationFields.ts`: секций больше
 * одной, а правила у них одни.
 */
import {
  colorField,
  namedColorField,
  numberField,
  optionalSubsection,
  subsection,
  type NumberRange,
} from './presentationFields.js';
import { closedKeys, isRecord, typeName } from './validation.js';

/**
 * Рассеянный свет сцены — половина секции `lighting` (PRES-2). Поля
 * необязательны: отсутствие — документированное умолчание подсистемы освещения
 * (`render-ts`, `lighting/config.ts`), а не ноль.
 */
export interface PresentationAmbientLight {
  /** Тон рассеянного света — `#rrggbb`. */
  readonly color?: string;
  /** Интенсивность, неотрицательная. */
  readonly intensity?: number;
}

/**
 * Направление направленного источника — откуда он светит: смещение позиции
 * источника от цели в мировых единицах. Не единичный вектор: нормирует его
 * рендер, а автор пишет удобные ему числа.
 */
export interface PresentationLightDirection {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
}

/** Направленный источник сцены — вторая половина секции `lighting` (PRES-2). */
export interface PresentationDirectionalLight {
  readonly color?: string;
  readonly intensity?: number;
  readonly direction?: PresentationLightDirection;
}

/**
 * Полусферная подсветка (REND-29): рассеянный свет двумя тонами — «небо» сверху,
 * «земля» снизу, — смешиваемыми по нормали поверхности. Подсекция необязательна,
 * и её ОТСУТСТВИЕ значит отсутствие источника, а не источник с умолчаниями: сцена
 * без подсекции рисуется байт-в-байт как до появления возможности.
 *
 * Поэтому и поля внутри необязательны безопасно: раз подсекция написана, автор
 * подсветку захотел, а дыры её полей закрывает подсистема (`lighting/config.ts`).
 */
export interface PresentationHemisphereLight {
  /** Тон «неба» — верхняя половина, `#rrggbb`. */
  readonly skyColor?: string;
  /** Тон «земли» — нижняя половина, `#rrggbb`. */
  readonly groundColor?: string;
  /** Интенсивность, неотрицательная. */
  readonly intensity?: number;
}

/**
 * Контровой источник (REND-29): второй направленный свет для отделения силуэтов
 * от фона. Состав — как у главного направленного источника, семантика
 * `direction` та же (смещение позиции источника от цели). Теней он не отбрасывает
 * и в реестр кастеров не входит — карты теней принадлежат главному источнику
 * (REND-30). Отсутствие подсекции — отсутствие источника.
 */
export interface PresentationRimLight {
  readonly color?: string;
  readonly intensity?: number;
  readonly direction?: PresentationLightDirection;
}

/**
 * Режим теней сцены, по возрастанию стоимости (`rendering` REND-30): теней нет;
 * контактные пятна под динамикой без карт теней; статика в кэшированной карте, а
 * динамика в покадровой; все кастеры покадрово. Порядок значений нормативен — по
 * нему считается потолок пресета качества (QUAL-1).
 */
export type PresentationShadowMode = 'none' | 'blob' | 'hybrid' | 'full';

/** Значения режима в порядке возрастания стоимости — единственный их перечень. */
export const PRESENTATION_SHADOW_MODES: readonly PresentationShadowMode[] = Object.freeze([
  'none',
  'blob',
  'hybrid',
  'full',
]);

/** Параметры теней секции `lighting` (PRES-2). */
export interface PresentationShadows {
  /** Режим теней; нет — `none` (тени выключены). */
  readonly mode?: PresentationShadowMode;
  /** Сторона карты теней в текселях, целая и положительная. */
  readonly mapSize?: number;
  /**
   * Доля интенсивности направленного источника, отданная кэшированной карте
   * статики в режиме `hybrid`, [0, 1]; остальное достаётся покадровой карте.
   * В режимах `none` и `full` источник один, и доля смысла не имеет.
   */
  readonly staticShare?: number;
}

/**
 * Фаза цикла времени суток (`rendering` REND-32): длительность и значения света
 * того же состава, что статическая часть секции. Дыры фазы закрываются
 * статической частью секции, а её дыры — умолчаниями подсистемы (REND-29): те же
 * правила, что у всего документа (PRES-2). Параметров теней в фазе нет и быть не
 * может — режим, сторона карты и доля статики принадлежат секции целиком.
 */
export interface PresentationLightingPhase {
  /**
   * Авторское имя фазы («утро», «ночь») — для читаемости документа и отладки.
   * Словаря имён у механизма MUST NOT существовать (REND-32): какие фазы есть и
   * как они называются, решает автор сцены.
   */
  readonly name?: string;
  /** Длительность фазы в секундах, положительная. */
  readonly seconds: number;
  readonly ambient?: PresentationAmbientLight;
  readonly directional?: PresentationDirectionalLight;
  /**
   * Значения полусферной подсветки на этой фазе — ТОЛЬКО если подсветка есть у
   * статической части секции (REND-32): наличие возможности — свойство секции,
   * фаза меняет лишь числа. Фаза, включающая источник из ничего, отвергается
   * валидацией адресно.
   */
  readonly hemisphere?: PresentationHemisphereLight;
  /** Значения контрового источника на этой фазе — под тем же правилом (REND-32). */
  readonly rim?: PresentationRimLight;
}

/**
 * Подсекция `cycle` секции `lighting` (REND-32): упорядоченный список из не
 * менее чем двух фаз и общая длительность перехода между ними. Исполняет цикл
 * подсистема освещения рендера, здесь — только форма данных: и длительность
 * перехода по умолчанию, и смысл интерполяции живут у неё.
 */
export interface PresentationLightingCycle {
  /** Длительность кроссфейда на границе фаз, секунды; нет — умолчание подсистемы. */
  readonly transitionSeconds?: number;
  /** Фазы по кругу; не менее двух — одной фазе чередоваться не с чем. */
  readonly phases: readonly PresentationLightingPhase[];
}

/**
 * Секция `lighting` — конфигурация освещения сцены (PRES-2, `rendering` REND-29). Как и секция `fog`,
 * все поля необязательны, состав закрыт, а политику картинки — сами умолчания —
 * держит подсистема рендера, не этот модуль: здесь проверяется форма данных.
 * На симуляцию секция не влияет ни байтом (PRES-4), и подсекция цикла (REND-32)
 * действует под тем же инвариантом наравне со статической частью.
 */
export interface PresentationLighting {
  readonly ambient?: PresentationAmbientLight;
  readonly directional?: PresentationDirectionalLight;
  /** Полусферная подсветка (REND-29); нет подсекции — нет источника. */
  readonly hemisphere?: PresentationHemisphereLight;
  /** Контровой источник (REND-29); нет подсекции — нет источника. */
  readonly rim?: PresentationRimLight;
  readonly shadows?: PresentationShadows;
  readonly cycle?: PresentationLightingCycle;
}

/**
 * Состав секции освещения и её подсекций — закрыт (PRES-2). Перечни лежат
 * рядом, потому что читаются они вместе: неизвестный ключ отвергается адресно и
 * называет допустимые соседи того же уровня, а не всего документа.
 */
const LIGHTING_KEYS: readonly string[] = [
  'ambient',
  'directional',
  'hemisphere',
  'rim',
  'shadows',
  'cycle',
];
const AMBIENT_KEYS: readonly string[] = ['color', 'intensity'];
const DIRECTIONAL_KEYS: readonly string[] = ['color', 'intensity', 'direction'];
const HEMISPHERE_KEYS: readonly string[] = ['skyColor', 'groundColor', 'intensity'];
const DIRECTION_KEYS: readonly string[] = ['x', 'y', 'z'];
const SHADOW_KEYS: readonly string[] = ['mode', 'mapSize', 'staticShare'];
const CYCLE_KEYS: readonly string[] = ['transitionSeconds', 'phases'];
const PHASE_KEYS: readonly string[] = [
  'name',
  'seconds',
  'ambient',
  'directional',
  'hemisphere',
  'rim',
];

/** Минимум фаз в цикле (REND-32): одной фазе чередоваться не с чем. */
const MIN_CYCLE_PHASES = 2;

/**
 * Рассеянный свет: тон и интенсивность (PRES-2). Адрес приходит параметром —
 * тот же состав описывает и статическую часть секции, и фазу цикла (REND-32), а
 * находка обязана называть адрес того уровня, на котором она нашлась.
 */
function validateAmbientLight(node: Record<string, unknown>, path: string, errors: string[]): void {
  closedKeys(node, path, AMBIENT_KEYS, errors);
  colorField(node, path, errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
}

/** Направленный источник: тон, интенсивность и направление (PRES-2). */
function validateDirectionalLight(
  node: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  closedKeys(node, path, DIRECTIONAL_KEYS, errors);
  colorField(node, path, errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
  if (!('direction' in node)) return;
  const axes = `${path}.direction`;
  const direction = subsection(node.direction, axes, errors);
  if (direction === null) return;
  closedKeys(direction, axes, DIRECTION_KEYS, errors);
  const range: NumberRange = { what: 'конечное число мировых единиц' };
  for (const axis of DIRECTION_KEYS) numberField(direction, axes, axis, range, errors);
}

/**
 * Полусферная подсветка: два тона и интенсивность (REND-29). Адрес приходит
 * параметром по тому же основанию, что у рассеянного света: тот же состав
 * описывает и статическую часть секции, и фазу цикла (REND-32).
 */
function validateHemisphereLight(
  node: Record<string, unknown>,
  path: string,
  errors: string[],
): void {
  closedKeys(node, path, HEMISPHERE_KEYS, errors);
  namedColorField(node, path, 'skyColor', errors);
  namedColorField(node, path, 'groundColor', errors);
  numberField(node, path, 'intensity', { what: 'неотрицательное число интенсивности', min: 0 }, errors);
}

/** Параметры теней: режим, сторона карты и доля интенсивности статики (PRES-2). */
function validateShadows(node: Record<string, unknown>, errors: string[]): void {
  const path = 'lighting.shadows';
  closedKeys(node, path, SHADOW_KEYS, errors);
  if ('mode' in node && !PRESENTATION_SHADOW_MODES.includes(node.mode as PresentationShadowMode)) {
    errors.push(
      `${path}.mode: ожидался режим теней из ${PRESENTATION_SHADOW_MODES.join(' | ')}, получено ${typeName(node.mode)}`,
    );
  }
  numberField(
    node,
    path,
    'mapSize',
    { what: 'целое положительное число текселей — сторона карты теней', min: 1, integer: true },
    errors,
  );
  numberField(
    node,
    path,
    'staticShare',
    { what: 'число из [0, 1] — доля интенсивности', min: 0, max: 1 },
    errors,
  );
}

/**
 * Какие необязательные источники есть у СТАТИЧЕСКОЙ части секции (REND-29):
 * наличие возможности — свойство секции, фаза меняет только числа (REND-32).
 * Флаги едут в проверку фазы, потому что решение «фаза называет то, чего нет»
 * принимается не внутри фазы.
 */
interface StaticExtras {
  readonly hemisphere: boolean;
  readonly rim: boolean;
}

/**
 * Фаза цикла (REND-32): длительность и значения света того же состава, что
 * статическая часть секции. Теневые поля названы в отказе поимённо — это не
 * опечатка, а попытка водить по кругу то, что принадлежит секции целиком:
 * смена режима или стороны карты пересобирает программы материалов, и кадром
 * такое не бывает.
 *
 * Полусферная подсветка и контровой источник — тем же порядком, но по другому
 * основанию: фаза вправе вести их по кругу, если они у секции ЕСТЬ, и не вправе
 * включать их из ничего. Появление источника на переходе потребовало бы
 * семантики «свет возник из воздуха», которой формат не описывает; того же
 * автор добивается интенсивностью 0 в фазе (REND-32, design D6).
 */
function validateCyclePhase(
  node: Record<string, unknown>,
  path: string,
  extras: StaticExtras,
  errors: string[],
): void {
  for (const key of Object.keys(node)) {
    if (PHASE_KEYS.includes(key)) continue;
    const shadowField = key === 'shadows' || SHADOW_KEYS.includes(key);
    errors.push(
      shadowField
        ? `${path}.${key}: параметров теней в фазе цикла нет и быть не может — режим, сторона карты и доля статики принадлежат секции целиком (REND-32, REND-30)`
        : `${path}.${key}: неизвестное поле (допустимы: ${PHASE_KEYS.join(', ')})`,
    );
  }
  if ('name' in node && (typeof node.name !== 'string' || node.name.length === 0)) {
    errors.push(
      `${path}.name: ожидалось имя фазы (непустая строка), получено ${typeName(node.name)}`,
    );
  }
  // Длительность обязательна и положительна: фаза нулевой длины — не фаза, и
  // прочтения у неё нет ни при каких умолчаниях подсистемы (REND-32).
  const seconds = node.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    errors.push(
      `${path}.seconds: обязательное поле — положительная длительность фазы в секундах, получено ${typeName(seconds)}`,
    );
  }
  const ambient = optionalSubsection(node, path, 'ambient', errors);
  if (ambient !== null) validateAmbientLight(ambient, `${path}.ambient`, errors);
  const directional = optionalSubsection(node, path, 'directional', errors);
  if (directional !== null) validateDirectionalLight(directional, `${path}.directional`, errors);
  validatePhaseExtra(node, path, 'hemisphere', extras.hemisphere, errors, (block, at) => {
    validateHemisphereLight(block, at, errors);
  });
  validatePhaseExtra(node, path, 'rim', extras.rim, errors, (block, at) => {
    validateDirectionalLight(block, at, errors);
  });
}

/**
 * Необязательный источник в фазе цикла (REND-32): фаза вправе вести его по
 * кругу, если он есть у СТАТИЧЕСКОЙ части секции, и не вправе заводить его из
 * ничего — появление источника на переходе потребовало бы семантики «свет
 * возник из воздуха», которой формат не описывает (design D6).
 *
 * Одно место на оба таких источника: полусферная подсветка и контровой
 * различаются только составом своего блока, а правило у них общее, и второе его
 * написание разошлось бы с первым молча.
 */
function validatePhaseExtra(
  node: Record<string, unknown>,
  path: string,
  key: 'hemisphere' | 'rim',
  presentInStatic: boolean,
  errors: string[],
  validate: (block: Record<string, unknown>, at: string) => void,
): void {
  if (!(key in node)) return;
  if (!presentInStatic) {
    errors.push(
      key === 'hemisphere'
        ? `${path}.hemisphere: полусферной подсветки нет в статической части секции — фаза меняет числа источника, а не заводит его (REND-32, REND-29)`
        : `${path}.rim: контрового источника нет в статической части секции — фаза меняет числа источника, а не заводит его (REND-32, REND-29)`,
    );
    return;
  }
  const block = optionalSubsection(node, path, key, errors);
  if (block !== null) validate(block, `${path}.${key}`);
}

/**
 * Переход не короче слота фазы — вырожденное значение, а не крайний случай
 * (REND-32). Кроссфейд занимает ХВОСТ слота фазы, поэтому слот, съеденный им
 * целиком, оставляет фазу без собственного облика: цикл превращается в
 * непрерывный дрейф — ту самую модель «фазы как ключевые кадры», которую формат
 * не описывает. Молча укорачивать переход было бы переписыванием авторского
 * числа, а состав документа держится на адресном отказе (PRES-2).
 *
 * Находка одна на цикл и адресована ДЛИТЕЛЬНОСТИ ПЕРЕХОДА: она одна на все фазы,
 * а самая короткая из них названа в тексте — по ней граница и проходит.
 * Ненаписанная длительность здесь не проверяется вовсе: её умолчание —
 * политика подсистемы рендера, и этот модуль его не знает (см. заголовок).
 */
function checkTransitionFitsPhases(
  node: Record<string, unknown>,
  phases: readonly unknown[],
  errors: string[],
): void {
  const transition = node.transitionSeconds;
  if (typeof transition !== 'number' || !Number.isFinite(transition) || transition < 0) return;
  let shortest = Number.POSITIVE_INFINITY;
  let at = -1;
  phases.forEach((phase, index) => {
    const seconds = isRecord(phase) ? phase.seconds : undefined;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
    if (seconds >= shortest) return;
    shortest = seconds;
    at = index;
  });
  if (at < 0 || transition < shortest) return;
  errors.push(
    `lighting.cycle.transitionSeconds: переход ${transition} с не короче слота фазы phases[${at}] (${shortest} с) — держать облик фазе тогда нечем (REND-32)`,
  );
}

/**
 * Подсекция цикла времени суток (REND-32): состав закрыт, список фаз — не
 * короче двух, каждая находка адресует ФАЗУ индексом, а не подсекцию целиком —
 * по тому же основанию, по какому его адресуют записи decoration.
 */
function validateLightingCycle(
  node: Record<string, unknown>,
  extras: StaticExtras,
  errors: string[],
): void {
  const path = 'lighting.cycle';
  closedKeys(node, path, CYCLE_KEYS, errors);
  numberField(
    node,
    path,
    'transitionSeconds',
    { what: 'неотрицательное число секунд — длительность перехода между фазами', min: 0 },
    errors,
  );
  const phases = node.phases;
  if (!Array.isArray(phases)) {
    errors.push(
      `${path}.phases: обязательное поле — список фаз цикла (не менее ${MIN_CYCLE_PHASES}), получено ${typeName(phases)}`,
    );
    return;
  }
  if (phases.length < MIN_CYCLE_PHASES) {
    errors.push(
      `${path}.phases: фаз ${phases.length} — циклу нужно не менее ${MIN_CYCLE_PHASES}: чередовать одну фазу не с чем (REND-32)`,
    );
  }
  phases.forEach((phase, index) => {
    const at = `${path}.phases[${index}]`;
    if (!isRecord(phase)) {
      errors.push(`${at}: ожидался объект фазы цикла, получено ${typeName(phase)}`);
      return;
    }
    validateCyclePhase(phase, at, extras, errors);
  });
  checkTransitionFitsPhases(node, phases, errors);
}

/**
 * Валидация секции `lighting` (PRES-2): состав закрыт на каждом уровне,
 * неизвестный ключ и значение не той формы отвергаются адресно — по общему
 * правилу документа. Семантику значений нормирует `rendering`, здесь только
 * форма: сами умолчания живут у подсистемы освещения рендера.
 */
export function validateLighting(section: unknown, errors: string[]): void {
  const root = subsection(section, 'lighting', errors);
  if (root === null) return;
  closedKeys(root, 'lighting', LIGHTING_KEYS, errors);
  const ambient = optionalSubsection(root, 'lighting', 'ambient', errors);
  if (ambient !== null) validateAmbientLight(ambient, 'lighting.ambient', errors);
  const directional = optionalSubsection(root, 'lighting', 'directional', errors);
  if (directional !== null) validateDirectionalLight(directional, 'lighting.directional', errors);
  const hemisphere = optionalSubsection(root, 'lighting', 'hemisphere', errors);
  if (hemisphere !== null) validateHemisphereLight(hemisphere, 'lighting.hemisphere', errors);
  // Состав контрового источника — состав направленного (REND-29): те же тон,
  // интенсивность и направление, и второго перечня этих полей быть не должно.
  const rim = optionalSubsection(root, 'lighting', 'rim', errors);
  if (rim !== null) validateDirectionalLight(rim, 'lighting.rim', errors);
  const shadows = optionalSubsection(root, 'lighting', 'shadows', errors);
  if (shadows !== null) validateShadows(shadows, errors);
  // Наличие необязательных источников — свойство СТАТИЧЕСКОЙ части (REND-32):
  // читается оно по написанным подсекциям, а не по их содержимому, — пустая
  // подсекция всё равно заводит источник с умолчаниями подсистемы.
  const cycle = optionalSubsection(root, 'lighting', 'cycle', errors);
  if (cycle !== null) {
    validateLightingCycle(cycle, { hemisphere: 'hemisphere' in root, rim: 'rim' in root }, errors);
  }
}
