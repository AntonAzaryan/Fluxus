/**
 * Загрузчик текстур PNG (решение 8: BLP предконвертируются в PNG, рантайм-BLP
 * при надобности добавится отдельным загрузчиком в реестр). Модуль ассетов
 * рендер-агностичен (ASSET-5), поэтому здесь только байты и mime —
 * декодирование делает потребитель (браузер — в ImageBitmap).
 */

import type { AssetLoader } from '../types.js';

/** Текстура как есть: байты + mime; декодирование на стороне потребителя. */
export interface TextureAsset {
  bytes: Uint8Array;
  mime: string;
}

/** 8-байтовая сигнатура PNG по спецификации. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export const pngTextureLoader: AssetLoader<TextureAsset> = {
  kind: 'texture',
  extensions: ['.png'],
  load(bytes: ArrayBuffer, id: string): TextureAsset {
    const view = new Uint8Array(bytes);
    const valid =
      view.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => view[i] === b);
    if (!valid) {
      throw new Error(`ассет "${id}" не является PNG: неверная сигнатура файла`);
    }
    return { bytes: view, mime: 'image/png' };
  },
};
