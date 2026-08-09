/**
 * Загрузчик парного presentation-документа сцены (`presentation-scene` PRES-1):
 * JSON.parse + схема-валидация. Регистрируется под видом 'presentation' с
 * расширением .json — одно расширение у нескольких видов ассета легально
 * (ASSET-3), и отдельного вида ассета ради него в модуле заводить нечего:
 * множество видов открыто, а регистрация загрузчика — предусмотренный способ
 * добавить вид.
 *
 * Отсутствие файла загрузчика не касается: «сцена без декораций» — законное
 * состояние (PRES-1), и решает это потребитель, который знает, есть ли пара в
 * дереве. Сюда доходят только байты уже найденного документа.
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { validatePresentationScene, type PresentationScene } from '../presentation.js';

export const presentationLoader: AssetLoader<PresentationScene> = {
  kind: 'presentation',
  extensions: ['.json'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): PresentationScene {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error(
        `presentation-документ "${ctx.id}": некорректный JSON — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const result = validatePresentationScene(doc);
    if (!result.ok) {
      throw new Error(
        `presentation-документ "${ctx.id}" не прошёл валидацию:\n- ${result.errors.join('\n- ')}`,
      );
    }
    return result.scene;
  },
};
