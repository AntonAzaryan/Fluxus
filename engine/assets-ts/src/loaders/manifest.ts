/**
 * Загрузчик JSON-манифеста визуалов (ASSET-6): JSON.parse + схема-валидация.
 * Ошибки формата и схемы превращаются сервисом в `failed` с причиной,
 * перечисляющей пути до невалидных полей.
 */

import type { AssetLoader } from '../types.js';
import { validateManifest, type VisualManifest } from '../manifest.js';

export const manifestLoader: AssetLoader<VisualManifest> = {
  kind: 'manifest',
  extensions: ['.json'],
  load(bytes: ArrayBuffer, id: string): VisualManifest {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error(
        `манифест "${id}": некорректный JSON — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const result = validateManifest(doc);
    if (!result.ok) {
      throw new Error(`манифест "${id}" не прошёл валидацию:\n- ${result.errors.join('\n- ')}`);
    }
    return result.manifest;
  },
};
