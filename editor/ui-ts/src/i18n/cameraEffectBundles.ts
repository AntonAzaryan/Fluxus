/**
 * Описания типов эффектов камеры и их параметров (ED-27, ED-28) — третий бандл
 * пакета интерфейса, рядом с хромом (`uiBundles.ts`).
 *
 * Почему третий, а не одна из двух уже существующих полок:
 *
 * - в бандл хрома их класть нельзя: `strings.test.ts` требует, чтобы все его
 *   ключи начинались с `ui.`, а это пространство ОПИСАНИЙ ПОЛЕЙ (ED-28) — ключ
 *   выводится из пути `['cameraEffect', <тип>, <параметр>]`, тем же
 *   `descriptionKey`, каким выводятся описания компонентов;
 * - в бандл `@fluxus/editor-core` — тоже нельзя: его гейт сводит бандл с
 *   путями, которые ПАКЕТ УМЕЕТ ВЫВЕСТИ (схемы ядра, правила валидации), а пути
 *   эффектов он вывести не может — описание живёт в `@fluxus/render`, которого
 *   у него нет. Строки числились бы осиротевшими и уронили бы гейт.
 *
 * Отсюда правило и для роста: строки приносит тот, кто приносит описание. Свой
 * гейт «бандл ↔ описание» (`test/cameraEffectStrings.test.ts`) выводит пути из
 * `CAMERA_EFFECTS_DESCRIPTION` в обе стороны — тип без строк красит тест, а не
 * показывает автору голый ключ.
 */
import { descriptionKey, type LocaleBundles } from '@fluxus/editor-core';
import { cameraEffectParams, type CameraEffectsDescription } from '@fluxus/assets';
import en from './locales/cameraEffect.en.json';
import ru from './locales/cameraEffect.ru.json';

/** Префикс пространства описаний эффектов — первый сегмент пути ED-28. */
const CAMERA_EFFECT_KIND = 'cameraEffect';
export const CAMERA_EFFECT_KEY_PREFIX = `${CAMERA_EFFECT_KIND}.`;

export const CAMERA_EFFECT_BUNDLES: LocaleBundles = { en, ru };

/**
 * Ключ описания самого типа: `cameraEffect.<тип>.effect`. Имя `effect` здесь то
 * же, что у поля записи, которым тип и называется (ASSET-8), — параметром оно
 * не бывает, и занять его тип не может.
 */
export function effectTypeKey(effect: string): string {
  return descriptionKey([CAMERA_EFFECT_KIND, effect, 'effect']);
}

/** Ключ описания параметра: `cameraEffect.<тип>.<параметр>` (ED-28). */
export function effectParamKey(effect: string, param: string): string {
  return descriptionKey([CAMERA_EFFECT_KIND, effect, param]);
}

/**
 * Все ключи, которых требует описание, — обе стороны гейта считаются по ним.
 * Перечня рядом с бандлом нет намеренно: рукописный список — та же таблица,
 * которую ED-28 запрещает для полей, и разошёлся бы он так же молча.
 */
export function cameraEffectKeys(description: CameraEffectsDescription): readonly string[] {
  const keys: string[] = [];
  for (const type of description.types) {
    keys.push(effectTypeKey(type.id));
    for (const param of cameraEffectParams(description, type)) {
      keys.push(effectParamKey(type.id, param.name));
    }
  }
  return keys;
}
