/**
 * Машинное описание кинематографического пути камеры (CAM-10) — единственный
 * перечень каналов ключа и имён сглаживания на весь репозиторий. Из него
 * проверяет секцию манифеста валидация (`assets` ASSET-17), по нему же редактор
 * построит таблицу ключей (`editor` ED-14), и по нему собирает путь сама камера.
 *
 * Устроено по образцу описания типов эффектов (CAM-9) и по тем же основаниям:
 * второй перечень, поддерживаемый отдельно, разошёлся бы с камерой молча.
 *
 * Человекочитаемых формулировок здесь нет ни одной (CAM-9, CAM-10): каналы и
 * сглаживания названы именами, по которым потребитель выводит ключ подсказки
 * (ED-28), а тексты живут в строковых ресурсах потребителя.
 *
 * Чтение описания графического контекста не требует: это данные.
 */
import type { CameraPathDescription, CameraPathChannelSpec } from '@fluxus/assets';

/**
 * Имена сглаживания параметра отрезка (CAM-10). Сглаживание применяется к
 * ПАРАМЕТРУ, а не к отдельному каналу: одно имя действует на все каналы
 * одинаково, и «плавно приехала точка, рывком приехала дистанция» не бывает.
 */
export const CAMERA_PATH_EASINGS: readonly string[] = Object.freeze([
  'linear',
  'easeIn',
  'easeOut',
  'easeInOut',
]);

/** Сглаживание по умолчанию: ключ, не назвавший имени, идёт линейно. */
export const DEFAULT_CAMERA_PATH_EASING = 'linear';

/**
 * Каналы ключа. Точка наблюдения обязательна — путь без неё не путь; прочие
 * необязательны, и канал, ключом не названный, берёт ДЕЙСТВУЮЩЕЕ значение
 * конфига камеры (CAM-10): путь, говорящий только о точке наблюдения, законен.
 *
 * Границы — граница осмысленности, а не окно вкуса (CAM-9): камера знает, что
 * дистанция положительна, но не знает, какой облёт уместен на этой арене.
 */
const CHANNELS: readonly CameraPathChannelSpec[] = Object.freeze([
  Object.freeze({ name: 'x', required: true }),
  Object.freeze({ name: 'y', required: true }),
  Object.freeze({ name: 'distance', required: false, min: 0 }),
  Object.freeze({ name: 'yaw', required: false }),
  Object.freeze({ name: 'pitch', required: false, min: -Math.PI / 2, max: Math.PI / 2 }),
  Object.freeze({ name: 'fovDeg', required: false, min: 0, max: 180 }),
]);

/** Описание пути целиком — то, что получают все три потребителя (CAM-10). */
export const CAMERA_PATH_DESCRIPTION: CameraPathDescription = Object.freeze({
  channels: CHANNELS,
  easings: CAMERA_PATH_EASINGS,
});

/**
 * Сглаживание параметра отрезка по имени; незнакомое имя идёт линейно —
 * манифест переживает код (ASSET-17), и кадр не место, где отказывают.
 */
export function easeParameter(easing: string, t: number): number {
  switch (easing) {
    case 'easeIn':
      return t * t;
    case 'easeOut':
      return t * (2 - t);
    case 'easeInOut':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default:
      return t;
  }
}
