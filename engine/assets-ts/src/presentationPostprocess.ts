/**
 * Секция `postprocess` парного presentation-документа (`presentation-scene`
 * PRES-2, `rendering` REND-34) — её состав и её валидация.
 *
 * Живёт отдельно от документа (`presentation.ts`) по тому же основанию, по
 * какому отдельно живёт секция `lighting`: это самостоятельный формат со своими
 * уровнями вложенности и своими адресами находок, читается и правится он сам по
 * себе, а в документ входит одним полем и одним вызовом.
 *
 * Границы те же: здесь проверяется ФОРМА данных, а политика картинки — сами
 * умолчания, формулы операторов, размер пирамиды bloom — живёт у подсистемы
 * пост-обработки рендера (`render-ts`, `postprocess/config.ts`). Умолчания
 * секции воспроизводят кадр до появления capability байт-в-байт: оператор
 * `none`, bloom выключен (REND-34). На симуляцию секция не влияет ни байтом
 * (PRES-4) — наравне с записями decoration и остальными секциями.
 */
import {
  booleanField,
  numberField,
  optionalSubsection,
  subsection,
} from './presentationFields.js';
import { closedKeys, typeName } from './validation.js';

/**
 * Оператор сведения яркости — ЗАКРЫТЫЙ словарь (REND-34). `none` — сведения нет
 * вовсе, и это умолчание: кадр сцены без секции остаётся сегодняшним.
 */
export type PresentationToneMappingOperator =
  | 'none'
  | 'linear'
  | 'reinhard'
  | 'aces'
  | 'agx'
  | 'neutral';

/**
 * Значения словаря — единственный их перечень: по нему валидация строит и
 * проверку, и текст находки, а рендер — выбор формулы (REND-34).
 */
export const PRESENTATION_TONE_MAPPING_OPERATORS: readonly PresentationToneMappingOperator[] =
  Object.freeze(['none', 'linear', 'reinhard', 'aces', 'agx', 'neutral']);

/** Подсекция `toneMapping` — сведение яркости кадра (REND-34). */
export interface PresentationToneMapping {
  /** Оператор из закрытого словаря; нет — `none`. */
  readonly operator?: PresentationToneMappingOperator;
  /** Экспозиция, положительная; нет — 1. */
  readonly exposure?: number;
}

/** Подсекция `bloom` — свечение заярких значений кадра (REND-34). */
export interface PresentationBloom {
  /** Включён ли bloom; нет — false, и отсутствие с явным false неразличимы. */
  readonly enabled?: boolean;
  /** Сила свечения в сведении, неотрицательная. */
  readonly strength?: number;
  /** Порог яркости в ЛИНЕЙНЫХ значениях до tone mapping, неотрицательный. */
  readonly threshold?: number;
  /** Ширина свечения — доля [0, 1] в пользу широких ярусов пирамиды. */
  readonly radius?: number;
}

/**
 * Подсекция `lut` — цветокоррекция кадра трёхмерной таблицей (REND-34).
 * Отсутствие подсекции значит ОТСУТСТВИЕ ПРОХОДА, а не таблицу с умолчаниями:
 * тождественной таблицы формат не знает, и заводить её было бы выборкой ни за
 * чем.
 */
export interface PresentationLut {
  /**
   * ID ассета таблицы цвета в дереве контента (`assets` ASSET-2) — путь от корня
   * дерева, как у любого ассета. Обязателен: подсекция без таблицы бессмысленна.
   */
  readonly asset: string;
  /** Доля применения таблицы, [0, 1]; нет — 1 (таблица действует целиком). */
  readonly amount?: number;
}

/**
 * Секция `postprocess` — конфигурация пост-обработки кадра (PRES-2, REND-34).
 * Как и секции `fog` и `lighting`, все поля необязательны, состав закрыт, а
 * политику картинки держит подсистема рендера, не этот модуль.
 */
export interface PresentationPostprocess {
  readonly toneMapping?: PresentationToneMapping;
  readonly bloom?: PresentationBloom;
  readonly lut?: PresentationLut;
}

/**
 * Состав секции и её подсекций — закрыт (PRES-2). Перечни лежат рядом, потому
 * что читаются вместе: неизвестный ключ отвергается адресно и называет
 * допустимых соседей ТОГО ЖЕ уровня, а не всего документа.
 */
const POSTPROCESS_KEYS: readonly string[] = ['toneMapping', 'bloom', 'lut'];
const TONE_MAPPING_KEYS: readonly string[] = ['operator', 'exposure'];
const BLOOM_KEYS: readonly string[] = ['enabled', 'strength', 'threshold', 'radius'];
const LUT_KEYS: readonly string[] = ['asset', 'amount'];

/**
 * Подсекция сведения яркости: оператор из закрытого словаря и положительная
 * экспозиция (REND-34). Ноль и отрицательная экспозиция не имеют прочтения ни
 * при каких умолчаниях подсистемы — нулевая экспозиция гасит кадр в чёрное, а
 * «выключить сведение» выражается оператором `none`, а не числом.
 */
function validateToneMapping(node: Record<string, unknown>, errors: string[]): void {
  const path = 'postprocess.toneMapping';
  closedKeys(node, path, TONE_MAPPING_KEYS, errors);
  if (
    'operator' in node &&
    !PRESENTATION_TONE_MAPPING_OPERATORS.includes(node.operator as PresentationToneMappingOperator)
  ) {
    errors.push(
      `${path}.operator: ожидался оператор сведения яркости из ${PRESENTATION_TONE_MAPPING_OPERATORS.join(' | ')}, получено ${typeName(node.operator)}`,
    );
  }
  numberField(
    node,
    path,
    'exposure',
    { what: 'положительное число экспозиции', min: 0, exclusive: true },
    errors,
  );
}

/**
 * Подсекция свечения: флаг, сила, порог и ширина (REND-34). Порог меряется в
 * линейных значениях ДО сведения яркости, поэтому верхней границы у него нет:
 * заяркостный диапазон HDR-кадра единицей не ограничен. Ширина, наоборот,
 * доля — вне [0, 1] у неё прочтения нет.
 */
function validateBloom(node: Record<string, unknown>, errors: string[]): void {
  const path = 'postprocess.bloom';
  closedKeys(node, path, BLOOM_KEYS, errors);
  booleanField(node, path, 'enabled', 'флаг включения bloom', errors);
  numberField(node, path, 'strength', { what: 'неотрицательная сила свечения', min: 0 }, errors);
  numberField(
    node,
    path,
    'threshold',
    { what: 'неотрицательный порог яркости в линейных значениях до tone mapping', min: 0 },
    errors,
  );
  numberField(node, path, 'radius', { what: 'ширина свечения — доля из [0, 1]', min: 0, max: 1 }, errors);
}

/**
 * Подсекция цветокоррекции: ID таблицы и доля применения (REND-34). ID
 * обязателен — подсекция без таблицы не имеет прочтения ни при каких умолчаниях
 * подсистемы: «без LUT» выражается отсутствием подсекции, а не пустым полем.
 * Существование самого файла здесь не проверяется: дерева контента этот модуль
 * не видит, а недоступный ассет — кадр без LUT и предупреждение (REND-34).
 */
function validateLut(node: Record<string, unknown>, errors: string[]): void {
  const path = 'postprocess.lut';
  closedKeys(node, path, LUT_KEYS, errors);
  const asset = node.asset;
  if (typeof asset !== 'string' || asset.length === 0) {
    errors.push(
      `${path}.asset: обязательное поле — ID ассета таблицы цвета (непустая строка), получено ${typeName(asset)}`,
    );
  }
  numberField(node, path, 'amount', { what: 'число из [0, 1] — доля применения таблицы', min: 0, max: 1 }, errors);
}

/**
 * Валидация секции `postprocess` (PRES-2): состав закрыт на каждом уровне,
 * неизвестный ключ и значение не той формы отвергаются адресно — по общему
 * правилу документа. Семантику значений нормирует `rendering` REND-34, здесь
 * только форма: сами умолчания живут у подсистемы пост-обработки рендера.
 */
export function validatePostprocess(section: unknown, errors: string[]): void {
  const root = subsection(section, 'postprocess', errors);
  if (root === null) return;
  closedKeys(root, 'postprocess', POSTPROCESS_KEYS, errors);
  const tone = optionalSubsection(root, 'postprocess', 'toneMapping', errors);
  if (tone !== null) validateToneMapping(tone, errors);
  const bloom = optionalSubsection(root, 'postprocess', 'bloom', errors);
  if (bloom !== null) validateBloom(bloom, errors);
  const lut = optionalSubsection(root, 'postprocess', 'lut', errors);
  if (lut !== null) validateLut(lut, errors);
}
