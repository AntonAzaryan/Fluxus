/**
 * Конфигурация пост-обработки кадра — ДАННЫЕ, а не механизм (REND-34): секция
 * `postprocess` парного presentation-документа (PRES-2), документированные
 * умолчания и их слияние. Живёт отдельно от подсистемы
 * (`subsystems/postprocess.ts`) тем же швом, что конфигурация тумана (FOW-10) и
 * освещения (REND-29): числа здесь правит дизайнер данными, а подсистема ниже —
 * их потребитель.
 *
 * Потолок пресета качества (QUAL-1) сюда не попадает намеренно: он ограничивает
 * ДЕЙСТВУЮЩЕЕ значение в подсистеме и авторскую секцию не трогает ни байтом.
 *
 * Умолчания воспроизводят кадр до появления capability БАЙТ-В-БАЙТ (REND-34):
 * оператор `none`, bloom выключен. В этом состоянии подсистема не заводит ни
 * промежуточной цели, ни полноэкранного прохода — стоимость пост-обработки
 * начинается там, где её включили (PERF-2).
 */
import type {
  PresentationPostprocess,
  PresentationToneMappingOperator,
} from '@game-mvp/assets';

/** Оператор сведения яркости — словарь формата, а не второй его перечень. */
export type ToneMappingOperator = PresentationToneMappingOperator;

/**
 * Действующая конфигурация пост-обработки — секция с закрытыми дырами. Плоская:
 * вложенность есть у авторского документа (там она группирует правку), а
 * подсистеме нужны значения, и лишний уровень она бы только разворачивала.
 */
export interface PostprocessRenderConfig {
  /** Оператор сведения яркости; `none` — сведения нет вовсе. */
  readonly operator: ToneMappingOperator;
  /** Экспозиция, положительная: множитель яркости перед оператором. */
  readonly exposure: number;
  /** Включён ли bloom. */
  readonly bloomEnabled: boolean;
  /** Сила свечения в сведении, неотрицательная. */
  readonly bloomStrength: number;
  /** Порог яркости в ЛИНЕЙНЫХ значениях до сведения, неотрицательный. */
  readonly bloomThreshold: number;
  /** Ширина свечения — доля [0, 1] в пользу широких ярусов пирамиды. */
  readonly bloomRadius: number;
}

/**
 * Документированные значения по умолчанию (REND-34). Оператор `none` и
 * выключенный bloom — это и есть «кадр как до появления capability»; числа
 * bloom при этом осмысленны сами по себе и действуют, как только автор включит
 * его одним флагом:
 *
 * - `bloomThreshold: 1` — светится то, что ЯРЧЕ БЕЛОГО: значение 1 в линейном
 *   кадре и есть белая точка, и порог ниже неё раздувал бы обычные светлые
 *   поверхности, а не источники;
 * - `bloomStrength: 0.4` — свечение читается добавкой к кадру, а не заменяет
 *   его: единица дала бы вклад вровень с самим источником;
 * - `bloomRadius: 0.5` — середина между узким и широким ореолом.
 */
export const DEFAULT_POSTPROCESS_CONFIG: PostprocessRenderConfig = Object.freeze({
  operator: 'none',
  exposure: 1,
  bloomEnabled: false,
  bloomStrength: 0.4,
  bloomThreshold: 1,
  bloomRadius: 0.5,
} satisfies PostprocessRenderConfig);

/** Секция документа поверх умолчаний: отсутствующее поле — умолчание (PRES-2). */
export function resolvePostprocessConfig(
  section?: PresentationPostprocess,
): PostprocessRenderConfig {
  const tone = section?.toneMapping;
  const bloom = section?.bloom;
  const fallback = DEFAULT_POSTPROCESS_CONFIG;
  return {
    operator: tone?.operator ?? fallback.operator,
    exposure: tone?.exposure ?? fallback.exposure,
    bloomEnabled: bloom?.enabled ?? fallback.bloomEnabled,
    bloomStrength: bloom?.strength ?? fallback.bloomStrength,
    bloomThreshold: bloom?.threshold ?? fallback.bloomThreshold,
    bloomRadius: bloom?.radius ?? fallback.bloomRadius,
  };
}

/**
 * Есть ли у цепочки работа (REND-34): сведение яркости оператором либо bloom.
 * Неактивная цепочка не добавляет в кадр ни цели, ни прохода — потребитель
 * рисует сцену ровно так, как рисовал до появления capability.
 *
 * Сила свечения нулём здесь НЕ проверяется: `strength: 0` — авторское значение
 * включённого bloom, а не выключенный bloom, и молчаливое «включено, но не
 * работает» прятало бы правку одного числа за поведением другого поля.
 */
export function isPostprocessActive(config: PostprocessRenderConfig): boolean {
  return config.operator !== 'none' || config.bloomEnabled;
}
