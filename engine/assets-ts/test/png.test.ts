import { describe, expect, it } from 'vitest';
import { AssetService, pngTextureLoader, type TextureAsset } from '../src/index.js';
import { MemoryAssetSource, settled } from './helpers.js';

/** Минимальный буфер с валидной PNG-сигнатурой (декодирование — не наше дело). */
function pngBytes(payload: number[] = [1, 2, 3]): ArrayBuffer {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return Uint8Array.from([...sig, ...payload]).buffer;
}

describe('Загрузчик PNG (решение 8: предконвертация, декодирует потребитель)', () => {
  it('валидная сигнатура — ready с байтами и mime', async () => {
    const source = pngBytes();
    const svc = new AssetService(new MemoryAssetSource(new Map([['skin.png', source]])));
    svc.registerLoader(pngTextureLoader);

    const h = svc.request<TextureAsset>('texture', 'skin.png');
    const s = await settled(svc, h);
    expect(s.status).toBe('ready');
    if (s.status !== 'ready') return;
    expect(s.data.mime).toBe('image/png');
    expect(s.data.bytes).toBeInstanceOf(Uint8Array);
    expect([...s.data.bytes]).toEqual([...new Uint8Array(source)]);
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
