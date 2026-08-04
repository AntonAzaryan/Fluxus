import { describe, expect, it } from 'vitest';
import { AssetService, type AssetLoader, type AssetState } from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

/** Загрузчик-заглушка: считает вызовы, каждый load создаёт новый объект. */
function fakeModelLoader(): AssetLoader<{ id: string }> & { loads: number } {
  const loader = {
    kind: 'model' as const,
    extensions: ['.fake'] as const,
    loads: 0,
    load(_bytes: ArrayBuffer, id: string): { id: string } {
      loader.loads += 1;
      return { id };
    },
  };
  return loader;
}

describe('AssetService: кэш и идентичность (ASSET-2)', () => {
  it('два request одного id возвращают тот же handle и один объект данных', async () => {
    const source = new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]]));
    const svc = new AssetService(source);
    const loader = fakeModelLoader();
    svc.registerLoader(loader);

    const h1 = svc.request<{ id: string }>('model', 'unit.fake');
    const h2 = svc.request<{ id: string }>('model', 'unit.fake');
    expect(h2).toBe(h1); // тот же разделяемый handle, не копия

    const s1 = await settled(svc, h1);
    const s2 = await settled(svc, h2);
    if (s1.status !== 'ready' || s2.status !== 'ready') throw new Error('ожидался ready');
    expect(s2.data).toBe(s1.data); // один разделяемый ассет
    expect(source.reads).toEqual(['unit.fake']); // файл прочитан один раз
    expect(loader.loads).toBe(1); // и распарсен один раз
  });

  it('запрос закэшированного id с другим kind — ошибка типа, а не данные', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());
    svc.request('model', 'unit.fake');
    expect(() => svc.request('texture', 'unit.fake')).toThrowError(/ASSET-2|уже запрошен/);
  });

  it('state/subscribe/retry по чужому handle — ошибка «не выдавался»', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map()));
    const foreign = { id: 'nope.fake', kind: 'model' as const };
    expect(() => svc.state(foreign)).toThrowError(/не выдавался/);
  });
});

describe('AssetService: реестр загрузчиков (ASSET-3)', () => {
  it('неизвестное расширение — failed «нет загрузчика», остальные грузятся', async () => {
    const source = new MemoryAssetSource(
      new Map([
        ['strange.xyz', bytesOf('?')],
        ['unit.fake', bytesOf('x')],
      ]),
    );
    const svc = new AssetService(source);
    svc.registerLoader(fakeModelLoader());

    const bad = svc.request('model', 'strange.xyz');
    const badState = svc.state(bad);
    expect(badState.status).toBe('failed');
    if (badState.status === 'failed') expect(badState.reason).toMatch(/нет загрузчика/);

    // сбой одного ассета не мешает другим (сервис не упал)
    const good = svc.request('model', 'unit.fake');
    expect((await settled(svc, good)).status).toBe('ready');
  });

  it('id без расширения — failed с причиной, не исключение', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map()));
    const h = svc.request('model', 'models/no-extension');
    const s = svc.state(h);
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/нет загрузчика/);
  });

  it('kind зарегистрированного загрузчика расходится с kind запроса — throw, ассет не кэшируется', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['a.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader()); // производит 'model'

    // Ошибка вида — синхронный throw, тем же тоном, что и про закэшированный
    // ассет: несовпадение видно сразу, до всякого ввода-вывода (ASSET-2).
    expect(() => svc.request('texture', 'a.fake')).toThrowError(/ASSET-2|другого типа/);

    // Кэш не засорён неудавшимся запросом: правильный запрос грузится с нуля.
    const h = svc.request('model', 'a.fake');
    expect(svc.state(h).status).toBe('loading');
  });
});

describe('AssetService: состояния и подписки (ASSET-4)', () => {
  it('request не блокирует: сразу после вызова состояние loading, потом ready', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());

    const h = svc.request('model', 'unit.fake');
    expect(svc.state(h).status).toBe('loading'); // синхронный опрос

    const seen: string[] = [];
    const unsubscribe = svc.subscribe(h, (s) => seen.push(s.status));
    expect(seen).toEqual(['loading']); // немедленный вызов с текущим состоянием

    const final = await settled(svc, h);
    expect(final.status).toBe('ready');
    expect(seen).toEqual(['loading', 'ready']); // уведомление о смене
    unsubscribe();
  });

  it('сбой источника — failed с причиной', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map())); // файла нет
    svc.registerLoader(fakeModelLoader());
    const h = svc.request('model', 'ghost.fake');
    const s = await settled(svc, h);
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/недоступен/);
  });

  it('исключение загрузчика — failed с его сообщением', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['bad.fake', bytesOf('x')]])));
    svc.registerLoader({
      kind: 'model',
      extensions: ['.fake'],
      load(): never {
        throw new Error('битый файл модели');
      },
    });
    const h = svc.request('model', 'bad.fake');
    const s = await settled(svc, h);
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toBe('битый файл модели');
  });

  it('state() отдаёт замороженное состояние, а не мутабельную внутреннюю ссылку (ASSET-5)', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());
    const h = svc.request('model', 'unit.fake');
    expect(Object.isFrozen(svc.state(h))).toBe(true); // loading

    const ready = await settled(svc, h);
    expect(Object.isFrozen(ready)).toBe(true);
    expect(() => {
      (ready as { status: string }).status = 'failed';
    }).toThrow(TypeError);
    // подмена «у себя» не состоялась — все наблюдатели видят прежнее состояние
    expect(svc.state(h).status).toBe('ready');
  });

  it('отписка прекращает уведомления', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());
    const h = svc.request('model', 'unit.fake');
    const seen: string[] = [];
    const unsubscribe = svc.subscribe(h, (s) => seen.push(s.status));
    unsubscribe();
    await settled(svc, h);
    expect(seen).toEqual(['loading']); // только немедленный вызов
  });
});

describe('AssetService: изоляция подписчиков', () => {
  it('бросивший подписчик не мешает следующему и не роняет загрузку', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());
    const h = svc.request('model', 'unit.fake');

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };

    const seen: string[] = [];
    try {
      // Первый в очереди подписчик ломается на каждом уведомлении.
      svc.subscribe(h, () => {
        throw new Error('подписчик сломался');
      });
      svc.subscribe(h, (s) => seen.push(s.status));

      // ready приходит из runLoad, запущенного как `void this.runLoad(...)`:
      // без перехвата исключение стало бы unhandled rejection.
      const final = await settled(svc, h);
      expect(final.status).toBe('ready');
    } finally {
      console.error = originalError;
    }

    expect(seen).toEqual(['loading', 'ready']); // второй подписчик уведомлён полностью
    // сбой каждого подписчика залогирован с id и видом ассета
    expect(errors.length).toBe(2);
    for (const args of errors) {
      expect(String(args[0])).toMatch(/unit\.fake.*model/);
    }
  });
});

describe('AssetService: retry (ASSET-4)', () => {
  it('после сбоя источника retry перезапускает загрузку', async () => {
    let attempts = 0;
    const source = new MemoryAssetSource(
      new Map([
        [
          'flaky.fake',
          () => {
            attempts += 1;
            if (attempts === 1) return Promise.reject(new Error('сеть моргнула'));
            return Promise.resolve(bytesOf('x'));
          },
        ],
      ]),
    );
    const svc = new AssetService(source);
    svc.registerLoader(fakeModelLoader());

    const h = svc.request('model', 'flaky.fake');
    const seen: string[] = [];
    svc.subscribe(h, (s) => seen.push(s.status));

    const failed = await settled(svc, h);
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') expect(failed.reason).toBe('сеть моргнула');

    svc.retry(h);
    const ready = await settled(svc, h);
    expect(ready.status).toBe('ready');
    expect(seen).toEqual(['loading', 'failed', 'loading', 'ready']);
  });

  it('retry для ready — no-op: повторной загрузки нет', async () => {
    const source = new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]]));
    const svc = new AssetService(source);
    svc.registerLoader(fakeModelLoader());
    const h = svc.request('model', 'unit.fake');
    await settled(svc, h);
    svc.retry(h);
    await settled(svc, h);
    expect(source.reads).toEqual(['unit.fake']);
  });

  it('retry: загрузчик появился, но производит другой kind — failed, не throw', () => {
    // Единственный оставшийся путь до проверки kind в startLoad: в момент
    // request загрузчика не было (failed «нет загрузчика»), а зарегистрировали
    // потом — и не тот. retry зовут из чужого кода, исключением его не бьём.
    const svc = new AssetService(new MemoryAssetSource(new Map([['a.fake', bytesOf('x')]])));
    const h = svc.request('texture', 'a.fake'); // загрузчика ещё нет
    expect(svc.state(h).status).toBe('failed');

    svc.registerLoader(fakeModelLoader()); // производит 'model', а не 'texture'
    expect(() => svc.retry(h)).not.toThrow();
    const s = svc.state(h);
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/запрошен как "texture"/);
  });

  it('retry подхватывает загрузчик, зарегистрированный после сбоя', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['late.fake', bytesOf('x')]])));
    const h = svc.request('model', 'late.fake'); // загрузчика ещё нет
    expect(svc.state(h).status).toBe('failed');

    svc.registerLoader(fakeModelLoader());
    svc.retry(h);
    expect((await settled(svc, h)).status).toBe('ready');
  });
});

describe('AssetService: подписка на уже завершённый ассет', () => {
  it('немедленный вызов приносит терминальное состояние', async () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['unit.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader());
    const h = svc.request<{ id: string }>('model', 'unit.fake');
    await settled(svc, h);

    let got: AssetState<{ id: string }> | null = null;
    svc.subscribe(h, (s) => {
      got = s;
    });
    expect(got).not.toBeNull();
    expect(got!.status).toBe('ready');
  });
});
