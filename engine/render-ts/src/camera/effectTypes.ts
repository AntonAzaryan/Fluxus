/**
 * Машинное описание типов эффектов камеры (CAM-9) — единственный перечень типов
 * на весь репозиторий. Из него строит эффекты слой эффектов (`director.ts`), по
 * нему проверяет секцию манифеста валидация (`assets` ASSET-8) и по нему же
 * редактор рисует таблицы привязок (`editor` ED-14): второго списка типов,
 * поддерживаемого отдельно, не существует.
 *
 * Добавление типа — новый класс со своим дескриптором в `effects.ts` плюс одна
 * строка здесь. Потребители при этом не правятся: в этом и смысл описания.
 *
 * Человекочитаемых формулировок в файле нет ни одной (CAM-9): типы и параметры
 * названы именами, по которым потребитель выводит ключ подсказки (ED-28), а
 * тексты живут в строковых ресурсах потребителя. Комментарии — не описание:
 * машинному читателю они не видны, а второй набор формулировок мимо ресурсов
 * начинается именно с поля со строкой.
 *
 * Чтение описания графического контекста не требует (CAM-9): это данные, и
 * заводить ради них рендер не нужно ни редактору, ни тестам.
 */
import type { CameraEffectParamSpec, CameraEffectsDescription } from '@fluxus/assets';
import { SHAKE_TYPE, SWAY_TYPE, type CameraEffectType } from './effects.js';

/**
 * Параметры привязки импульсного эффекта — не типа, а самой записи: сила
 * импульса и радиус ослабления по расстоянию (CAM-6). Общие для любого
 * импульсного типа, поэтому живут в описании рядом с типами, а не в диспетчере:
 * не названные нигде, они существовали бы только в коде, который их читает, и
 * редактор не показал бы автору, чем крутить силу.
 */
const IMPULSE_BINDING: readonly CameraEffectParamSpec[] = Object.freeze([
  Object.freeze({ name: 'amplitude', defaultValue: 0.6, min: 0 }),
  // Умолчание радиуса — «без ослабления»: запись без радиуса трясёт одинаково
  // на всей арене, и это ответ, а не отсутствие ответа.
  Object.freeze({ name: 'radius', defaultValue: Number.POSITIVE_INFINITY, min: 0 }),
]);

/**
 * Параметров привязки у длящихся эффектов нет: длящийся включён присутствием
 * состояния, и силы у этого включения не бывает. Пустой список, а не отсутствие
 * ключа, — потребитель перебирает оба вида одинаково.
 */
const LASTING_BINDING: readonly CameraEffectParamSpec[] = Object.freeze([]);

/** Типы эффектов, которые умеет эта сборка камеры. */
export const CAMERA_EFFECT_TYPES: readonly CameraEffectType[] = Object.freeze([
  SHAKE_TYPE,
  SWAY_TYPE,
]);

/**
 * То же описание, но с фабриками: слою эффектов нужен второй уровень контракта
 * (`CameraEffectType`), валидации и редактору хватает первого
 * (`CameraEffectTypeSpec` в `@fluxus/assets`). Описание при этом ОДНО — второй
 * тип не заводит второго перечня, он лишь называет, что у него есть сверх.
 */
export interface CameraEffectsCatalog extends CameraEffectsDescription {
  readonly types: readonly CameraEffectType[];
}

/** Описание целиком — то, что получают все три потребителя (CAM-9). */
export const CAMERA_EFFECTS_DESCRIPTION: CameraEffectsCatalog = Object.freeze({
  types: CAMERA_EFFECT_TYPES,
  binding: Object.freeze({ impulse: IMPULSE_BINDING, lasting: LASTING_BINDING }),
});
