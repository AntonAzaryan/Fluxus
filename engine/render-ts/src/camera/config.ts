/**
 * Машинный адрес единого конфига камеры (CAM-1): секция конфига манифеста
 * визуалов (`assets` ASSET-10) — значения, код — состав параметров и умолчания.
 *
 * Перечень параметров ВЫВОДИТСЯ из умолчаний (`DEFAULT_CAMERA_CONFIG`), а не
 * пишется вторым списком: список, поддерживаемый отдельно, разошёлся бы с
 * конфигом молча — ровно та беда, которой машинное описание типов эффектов
 * (CAM-9) не допускает у секции эффектов.
 *
 * Здесь же — сборка частичного конфига из секции: значения манифеста ложатся
 * ПОВЕРХ умолчаний кода (это делает `CameraRig`, принимая `Partial`), поэтому
 * отсутствие секции и отсутствие отдельного параметра означают одно и то же —
 * умолчание кода. Параметр, конфигом не объявленный, пропускается с
 * предупреждением и отказом не является (ASSET-10).
 */
import type { CameraConfigDescription, CameraConfigSection } from '@fluxus/assets';
import { DEFAULT_CAMERA_CONFIG, type CameraConfig } from './rig.js';

/** Имена параметров конфига камеры — единственный их перечень (CAM-1). */
export const CAMERA_CONFIG_PARAMS: readonly string[] = Object.freeze(
  Object.keys(DEFAULT_CAMERA_CONFIG),
);

/**
 * Описание конфига целиком — то, что получает валидация манифеста (ASSET-10):
 * с ним неизвестный параметр секции становится предупреждением ещё на загрузке,
 * а не молча пропадает у потребителя.
 */
export const CAMERA_CONFIG_DESCRIPTION: CameraConfigDescription = Object.freeze({
  params: CAMERA_CONFIG_PARAMS,
});

export interface CameraConfigFromManifestOptions {
  /** Канал предупреждений; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

const isKnownParam = (param: string): param is keyof CameraConfig =>
  CAMERA_CONFIG_PARAMS.includes(param);

/**
 * Секция манифеста → частичный конфиг камеры (CAM-1, ASSET-10). Нет секции —
 * пустой результат, то есть умолчания кода целиком и прежнее поведение кадра.
 */
export function cameraConfigFromManifest(
  section: CameraConfigSection | undefined,
  options: CameraConfigFromManifestOptions = {},
): Partial<CameraConfig> {
  const config: Partial<Record<keyof CameraConfig, number>> = {};
  if (section === undefined) return config;
  const warn =
    options.warn ??
    ((message: string): void => {
      console.warn(message);
    });
  for (const [param, value] of Object.entries(section)) {
    if (!isKnownParam(param)) {
      warn(`конфиг камеры: параметр "${param}" коду камеры неизвестен — пропущен (ASSET-10)`);
      continue;
    }
    // Нечисловое значение — ошибка валидации манифеста (ASSET-10), но кадр не
    // место, где отказывают (CAM-6): потребитель, получивший такое значение
    // мимо валидации, берёт умолчание кода и говорит об этом вслух.
    if (!Number.isFinite(value)) {
      warn(`конфиг камеры: параметр "${param}" — не конечное число, взято умолчание кода`);
      continue;
    }
    config[param] = value;
  }
  return config;
}
