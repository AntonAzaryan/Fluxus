import { describe, expect, it } from 'vitest';
import { AssetService, decodePng, pngTextureLoader, type DecodedImage } from '../src/index.js';
import { MemoryAssetSource, settled } from './helpers.js';
import { encodePng } from './pngEncode.js';

/** Пиксель из RGBA8-буфера декодированного изображения. */
function pixel(image: DecodedImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.pixels.subarray(at, at + 4)];
}

describe('Декодер PNG (ASSET-5: текстурный ассет — декодированное изображение)', () => {
  it('RGBA8: пиксели доезжают побайтово, размеры и формат заявлены', async () => {
    const rows = [
      Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 128]),
      Uint8Array.from([0, 0, 255, 255, 9, 9, 9, 0]),
    ];
    const image = await decodePng(await encodePng({ width: 2, height: 2, colorType: 6, rows }), 'a.png');

    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(image.format).toBe('rgba8');
    expect(image.pixels.length).toBe(2 * 2 * 4);
    expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 1, 0)).toEqual([0, 255, 0, 128]);
    expect(pixel(image, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(pixel(image, 1, 1)).toEqual([9, 9, 9, 0]);
  });

  it('все пять построчных фильтров восстанавливаются одинаково', async () => {
    // Одни и те же пиксели, закодированные разными фильтрами: декодер обязан
    // вернуть идентичный результат — иначе арифметика unfilter врёт.
    const rows = [
      Uint8Array.from([10, 20, 30, 255, 40, 50, 60, 255]),
      Uint8Array.from([70, 80, 90, 255, 100, 110, 120, 255]),
      Uint8Array.from([130, 140, 150, 255, 160, 170, 180, 255]),
      Uint8Array.from([190, 200, 210, 255, 220, 230, 240, 255]),
      Uint8Array.from([250, 5, 15, 255, 25, 35, 45, 255]),
    ];
    const plain = await decodePng(
      await encodePng({ width: 2, height: 5, colorType: 6, rows }),
      'plain.png',
    );
    const filtered = await decodePng(
      await encodePng({ width: 2, height: 5, colorType: 6, rows, filters: [0, 1, 2, 3, 4] }),
      'filtered.png',
    );
    expect([...filtered.pixels]).toEqual([...plain.pixels]);
  });

  it('RGB без альфы — альфа 255', async () => {
    const rows = [Uint8Array.from([1, 2, 3, 4, 5, 6])];
    const image = await decodePng(await encodePng({ width: 2, height: 1, colorType: 2, rows }), 'rgb.png');
    expect(pixel(image, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixel(image, 1, 0)).toEqual([4, 5, 6, 255]);
  });

  it('grayscale и grayscale+alpha разворачиваются в RGBA', async () => {
    const gray = await decodePng(
      await encodePng({ width: 2, height: 1, colorType: 0, rows: [Uint8Array.from([7, 200])] }),
      'gray.png',
    );
    expect(pixel(gray, 0, 0)).toEqual([7, 7, 7, 255]);
    expect(pixel(gray, 1, 0)).toEqual([200, 200, 200, 255]);

    const grayAlpha = await decodePng(
      await encodePng({ width: 2, height: 1, colorType: 4, rows: [Uint8Array.from([7, 64, 200, 0])] }),
      'ga.png',
    );
    expect(pixel(grayAlpha, 0, 0)).toEqual([7, 7, 7, 64]);
    expect(pixel(grayAlpha, 1, 0)).toEqual([200, 200, 200, 0]);
  });

  it('палитра с tRNS: цвет из PLTE, альфа из tRNS', async () => {
    const image = await decodePng(
      await encodePng({
        width: 3,
        height: 1,
        colorType: 3,
        rows: [Uint8Array.from([0, 1, 2])],
        palette: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255]),
        transparency: Uint8Array.from([0, 128]), // третий индекс без записи — 255
      }),
      'pal.png',
    );
    expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 0]);
    expect(pixel(image, 1, 0)).toEqual([0, 255, 0, 128]);
    expect(pixel(image, 2, 0)).toEqual([0, 0, 255, 255]);
  });

  it('16 бит на канал приводятся к 8 (берётся старший байт)', async () => {
    const rows = [Uint8Array.from([0xab, 0xcd, 0x00, 0x01, 0xff, 0xfe])];
    const image = await decodePng(
      await encodePng({ width: 1, height: 1, colorType: 2, bitDepth: 16, rows }),
      'deep.png',
    );
    expect(pixel(image, 0, 0)).toEqual([0xab, 0x00, 0xff, 255]);
  });

  it('чересстрочный PNG отклоняется с внятной причиной', async () => {
    const png = await encodePng({
      width: 1,
      height: 1,
      colorType: 6,
      rows: [Uint8Array.from([1, 2, 3, 4])],
      interlace: 1,
    });
    await expect(decodePng(png, 'i.png')).rejects.toThrow(/Adam7|чересстрочн/);
  });

  it('битовая глубина меньше 8 отклоняется с внятной причиной', async () => {
    const png = await encodePng({
      width: 2,
      height: 1,
      colorType: 3,
      bitDepth: 4,
      rows: [Uint8Array.from([0x01])],
      palette: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    });
    await expect(decodePng(png, 'low.png')).rejects.toThrow(/4 бит/);
  });
});

describe('Загрузчик PNG в сервисе (ASSET-3, ASSET-4)', () => {
  it('валидный файл — ready с декодированным изображением', async () => {
    const png = await encodePng({
      width: 1,
      height: 1,
      colorType: 6,
      rows: [Uint8Array.from([12, 34, 56, 78])],
    });
    const svc = new AssetService(new MemoryAssetSource(new Map([['skin.png', png]])));
    svc.registerLoader(pngTextureLoader);

    const s = await settled(svc, svc.request<DecodedImage>('texture', 'skin.png'));
    expect(s.status).toBe('ready');
    if (s.status !== 'ready') return;
    expect(s.data.format).toBe('rgba8');
    expect([...s.data.pixels]).toEqual([12, 34, 56, 78]);
  });

  it('десять потребителей одной текстуры — один декод, одни пиксели', async () => {
    // Ради этого текстура и стала декодированным изображением: разделяется
    // результат работы, а не сжатый буфер, который ничего не стоит.
    const png = await encodePng({
      width: 1,
      height: 1,
      colorType: 6,
      rows: [Uint8Array.from([1, 2, 3, 4])],
    });
    const source = new MemoryAssetSource(new Map([['shared.png', png]]));
    const svc = new AssetService(source);
    svc.registerLoader(pngTextureLoader);

    const handles = Array.from({ length: 10 }, () =>
      svc.request<DecodedImage>('texture', 'shared.png'),
    );
    const states = await Promise.all(handles.map((h) => settled(svc, h)));
    const first = states[0]!;
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    for (const state of states) {
      expect(state.status).toBe('ready');
      if (state.status === 'ready') expect(state.data.pixels).toBe(first.data.pixels);
    }
    expect(source.reads).toEqual(['shared.png']);
  });

  it('битая сигнатура — failed с причиной «не является PNG»', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(new Map([['fake.png', Uint8Array.from([1, 2, 3, 4]).buffer]])),
    );
    svc.registerLoader(pngTextureLoader);
    const s = await settled(svc, svc.request('texture', 'fake.png'));
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/не является PNG/);
  });

  it('пустой файл — failed, не исключение', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['empty.png', new ArrayBuffer(0)]])));
    svc.registerLoader(pngTextureLoader);
    const s = await settled(svc, svc.request('texture', 'empty.png'));
    expect(s.status).toBe('failed');
  });
});
