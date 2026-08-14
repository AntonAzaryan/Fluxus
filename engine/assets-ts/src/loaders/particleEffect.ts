/**
 * Загрузчик эмиттерного ассета (ASSET-14): JSON.parse + проверка формы корня.
 * Регистрируется под видом 'particle-effect' с расширением .json — одно
 * расширение у нескольких видов ассета легально (ASSET-3), и именно поэтому
 * ключ реестра — пара «вид + формат», а не расширение.
 *
 * Библиотеки частиц загрузчик не знает: документ разбирается и валидируется
 * headless, в Node, без браузера и без рендера (ASSET-5, ASSET-14). В объекты
 * библиотеки его разворачивает подсистема частиц рендера при первом
 * использовании (`rendering` REND-24).
 */

import type { AssetLoader, LoaderContext } from '../types.js';
import { validateParticleEffect, type ParticleEffectDocument } from '../particleEffect.js';

export const particleEffectLoader: AssetLoader<ParticleEffectDocument> = {
  kind: 'particle-effect',
  extensions: ['.json'],
  load(bytes: ArrayBuffer, ctx: LoaderContext): ParticleEffectDocument {
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new Error(
        `эмиттерный ассет "${ctx.id}": некорректный JSON — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const result = validateParticleEffect(doc);
    if (!result.ok) {
      throw new Error(
        `эмиттерный ассет "${ctx.id}" не прошёл валидацию:\n- ${result.errors.join('\n- ')}`,
      );
    }
    return result.effect;
  },
};
