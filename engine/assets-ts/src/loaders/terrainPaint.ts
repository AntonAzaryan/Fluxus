/**
 * Загрузчик карты раскраски террейна (ASSET-15): JSON.parse + схема-валидация.
 * Регистрируется под видом 'terrain-paint' с расширением .json — одно
 * расширение у нескольких видов ассета легально (ASSET-3). Ошибки формата
 * превращаются сервисом в `failed` с причиной, называющей ряд и клетку.
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { validateTerrainPaint, type TerrainPaintMap } from '../terrainPaint.js';
import { findingsList, parseAssetJson } from '../validation.js';

export const terrainPaintLoader: AssetLoader<TerrainPaintMap> = {
  kind: 'terrain-paint',
  extensions: ['.json'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): TerrainPaintMap {
    const result = validateTerrainPaint(parseAssetJson(bytes, 'карта раскраски террейна', ctx.id));
    if (!result.ok) {
      throw new Error(
        `карта раскраски террейна "${ctx.id}" не прошла валидацию:${findingsList(result.errors)}`,
      );
    }
    return result.map;
  },
};
