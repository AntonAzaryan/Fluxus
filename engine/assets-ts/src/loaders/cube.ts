/**
 * Загрузчик таблицы цветокоррекции `.cube` (ASSET-3, `rendering` REND-34):
 * декодирование текста + разбор формата. Регистрируется под видом `lut` —
 * множество видов ОТКРЫТО (ASSET-3), и появление вида правкой ядра модуля не
 * является. Ошибки формата сервис превращает в `failed` с причиной, называющей
 * строку файла (REND-34: кадр без LUT и предупреждение с причиной, а не падение).
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { parseCubeLut, type ColorLut } from '../colorLut.js';

/** Вид ассета таблицы цвета — один перечень имени на регистрацию и на запрос. */
export const LUT_ASSET_KIND = 'lut';

export const cubeLutLoader: AssetLoader<ColorLut> = {
  kind: LUT_ASSET_KIND,
  extensions: ['.cube'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): ColorLut {
    const result = parseCubeLut(new TextDecoder().decode(bytes));
    if (!result.ok) {
      throw new Error(`таблица цвета "${ctx.id}" не разобрана:\n- ${result.errors.join('\n- ')}`);
    }
    return result.lut;
  },
};
