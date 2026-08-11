/**
 * Загрузчик карты кривизны террейна (ASSET-7): JSON.parse + схема-валидация.
 * Регистрируется под видом 'terrain-curvature' с расширением .json — одно
 * расширение у нескольких видов ассета легально (ASSET-3). Ошибки формата
 * превращаются сервисом в `failed` с причиной, называющей ряд и узел.
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { validateCurvatureMap, type TerrainCurvatureMap } from '../curvature.js';

export const curvatureLoader: AssetLoader<TerrainCurvatureMap> = {
  kind: 'terrain-curvature',
  extensions: ['.json'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): TerrainCurvatureMap {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error(
        `карта кривизны "${ctx.id}": некорректный JSON — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const result = validateCurvatureMap(doc);
    if (!result.ok) {
      throw new Error(
        `карта кривизны "${ctx.id}" не прошла валидацию:\n- ${result.errors.join('\n- ')}`,
      );
    }
    return result.map;
  },
};
