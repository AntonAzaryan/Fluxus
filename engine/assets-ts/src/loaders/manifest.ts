/**
 * Загрузчик JSON-манифеста визуалов (ASSET-6): JSON.parse + схема-валидация.
 * Ошибки формата и схемы превращаются сервисом в `failed` с причиной,
 * перечисляющей пути до невалидных полей.
 *
 * Описание типов эффектов камеры (`camera` CAM-9) загрузчик не знает и знать не
 * может — оно живёт в коде камеры, а модуль ассетов от рендера не зависит.
 * Поэтому его подаёт тот, кто собирает загрузчик (`createManifestLoader`), и
 * ровно тогда секция эффектов проверяется по нему (ASSET-8). Предупреждения
 * логируются и загрузку не роняют: манифест переживает код.
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { validateManifest, type CameraEffectsDescription, type VisualManifest } from '../manifest.js';

export interface ManifestLoaderOptions {
  /** Машинное описание типов эффектов камеры (CAM-9); нет — секция проверяется структурно. */
  readonly cameraEffects?: CameraEffectsDescription;
  /** Канал предупреждений; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/**
 * Загрузчик манифеста с описанием типов эффектов. Собирает его потребитель:
 * описание — знание камеры, и путь «assets → render» запрещён направлением
 * графа зависимостей.
 */
export function createManifestLoader(options: ManifestLoaderOptions = {}): AssetLoader<VisualManifest> {
  const warn =
    options.warn ??
    ((message: string): void => {
      console.warn(message);
    });
  return {
    kind: 'manifest',
    extensions: ['.json'],
    load(bytes: ArrayBuffer, ctx: LoaderContext): VisualManifest {
      let doc: unknown;
      try {
        doc = JSON.parse(new TextDecoder().decode(bytes));
      } catch (e) {
        throw new Error(
          `манифест "${ctx.id}": некорректный JSON — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const result = validateManifest(
        doc,
        options.cameraEffects === undefined ? {} : { cameraEffects: options.cameraEffects },
      );
      // Предупреждение — один раз на загрузку и до отказа: даже у манифеста,
      // не прошедшего валидацию, автору полезно увидеть обе половины ответа.
      for (const message of result.warnings) warn(`манифест "${ctx.id}": ${message}`);
      if (!result.ok) {
        throw new Error(`манифест "${ctx.id}" не прошёл валидацию:\n- ${result.errors.join('\n- ')}`);
      }
      return result.manifest;
    },
  };
}

/** Загрузчик без описания типов: секция эффектов проверяется структурно (ASSET-8). */
export const manifestLoader: AssetLoader<VisualManifest> = createManifestLoader();
