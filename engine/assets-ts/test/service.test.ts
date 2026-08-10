import { describe, expect, it } from 'vitest';
import {
  AssetService,
  resolveDependencyPath,
  type AssetLoader,
  type AssetState,
  type LoaderContext,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

/** Загрузчик-заглушка: считает вызовы, каждый load создаёт новый объект. */
function fakeModelLoader(): AssetLoader<{ id: string }> & { loads: number } {
  const loader = {
    kind: 'model' as const,
    extensions: ['.fake'] as const,
    loads: 0,
    load(_bytes: ArrayBuffer, ctx: LoaderContext): { id: string } {
      loader.loads += 1;
      return { id: ctx.id };
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
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- baseline
    expect(() => svc.request('texture', 'unit.fake')).toThrowError(/ASSET-2|уже запрошен/);
  });

  it('state/subscribe/retry по чужому handle — ошибка «не выдавался»', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map()));
    const foreign = { id: 'nope.fake', kind: 'model' as const };
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- baseline
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

  it('расширение знакомо, но под другим видом — failed, и причина называет этот вид', () => {
    const svc = new AssetService(new MemoryAssetSource(new Map([['a.fake', bytesOf('x')]])));
    svc.registerLoader(fakeModelLoader()); // производит 'model'

    // Ключ реестра — пара «вид + формат», поэтому под видом texture загрузчика
    // для .fake просто нет. Это вопрос комплектации рантайма (его могут
    // зарегистрировать позже), значит failed, а не throw — но причина обязана
    // назвать виды, под которыми расширение всё-таки знакомо: чаще всего это
    // именно опечатка потребителя, и молчать о ней значит вредить отладке.
    const s = svc.state(svc.request('texture', 'a.fake'));
    expect(s.status).toBe('failed');
    if (s.status === 'failed') {
      expect(s.reason).toMatch(/нет загрузчика для вида "texture"/);
      expect(s.reason).toMatch(/зарегистрированы виды: model/);
    }
  });

  it('одно расширение у двух видов: регистрации не конфликтуют', async () => {
    // `.json` — манифест визуалов и одновременно расширение нативного формата
    // моделей three.js. При ключе реестра по одному расширению второй загрузчик
    // молча вытеснил бы первый (ASSET-3).
    const svc = new AssetService(
      new MemoryAssetSource(
        new Map([
          ['unit.json', bytesOf('m')],
          ['visuals.json', bytesOf('v')],
        ]),
      ),
    );
    svc.registerLoader({
      kind: 'model',
      extensions: ['.json'],
      load: () => ({ what: 'модель' }),
    });
    svc.registerLoader({
      kind: 'manifest',
      extensions: ['.json'],
      load: () => ({ what: 'манифест' }),
    });

    const model = await settled(svc, svc.request<{ what: string }>('model', 'unit.json'));
    const manifest = await settled(svc, svc.request<{ what: string }>('manifest', 'visuals.json'));
    expect(model.status === 'ready' && model.data.what).toBe('модель');
    expect(manifest.status === 'ready' && manifest.data.what).toBe('манифест');
  });
});

describe('AssetService: зависимости формата (ASSET-3)', () => {
  /** Загрузчик формата из двух файлов: описание ссылается на буфер рядом. */
  const twoFileLoader: AssetLoader<string> = {
    kind: 'model',
    extensions: ['.desc'],
    async load(bytes: ArrayBuffer, ctx: LoaderContext): Promise<string> {
      const buffer = await ctx.read(new TextDecoder().decode(bytes));
      return new TextDecoder().decode(buffer);
    },
  };

  it('загрузчик дочитывает соседний файл по относительному пути', async () => {
    const source = new MemoryAssetSource(
      new Map([
        ['models/unit.desc', bytesOf('unit.bin')],
        ['models/unit.bin', bytesOf('геометрия')],
      ]),
    );
    const svc = new AssetService(source);
    svc.registerLoader(twoFileLoader);

    const s = await settled(svc, svc.request<string>('model', 'models/unit.desc'));
    expect(s.status).toBe('ready');
    if (s.status === 'ready') expect(s.data).toBe('геометрия');
    // Путь разрешён от ДИРЕКТОРИИ ассета, а не от корня дерева контента.
    expect(source.reads).toEqual(['models/unit.desc', 'models/unit.bin']);
  });

  it('недостающая зависимость — failed с причиной, называющей файл', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(new Map([['models/unit.desc', bytesOf('missing.bin')]])),
    );
    svc.registerLoader(twoFileLoader);

    const s = await settled(svc, svc.request('model', 'models/unit.desc'));
    expect(s.status).toBe('failed');
    if (s.status === 'failed') {
      expect(s.reason).toMatch(/models\/missing\.bin/);
      expect(s.reason).toMatch(/зависимость/);
    }
  });

  it('сбой одной зависимости не мешает остальным ассетам', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(
        new Map([
          ['a.desc', bytesOf('nope.bin')],
          ['b.desc', bytesOf('b.bin')],
          ['b.bin', bytesOf('цел')],
        ]),
      ),
    );
    svc.registerLoader(twoFileLoader);

    const bad = await settled(svc, svc.request('model', 'a.desc'));
    const good = await settled(svc, svc.request<string>('model', 'b.desc'));
    expect(bad.status).toBe('failed');
    expect(good.status).toBe('ready');
  });

  it('разрешение путей: точки, поддиректории и запрет выхода за корень', () => {
    expect(resolveDependencyPath('models/unit.desc', 'unit.bin')).toBe('models/unit.bin');
    expect(resolveDependencyPath('models/unit.desc', './tex/skin.png')).toBe('models/tex/skin.png');
    expect(resolveDependencyPath('models/a/unit.desc', '../shared/atlas.png')).toBe(
      'models/shared/atlas.png',
    );
    expect(resolveDependencyPath('models/unit.desc', '/textures/skin.png')).toBe(
      'textures/skin.png',
    );
    // Дерево контента — не файловая система хоста: наружу ходу нет.
    expect(() => resolveDependencyPath('models/unit.desc', '../../etc/passwd')).toThrow(
      /за корень/,
    );
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

  it('retry: зарегистрировали загрузчик того же формата, но чужого вида — снова failed, не throw', () => {
    // retry зовут из чужого кода, не готового к исключению от давно
    // запрошенного ассета, поэтому «загрузчика под мою пару так и нет» — failed.
    const svc = new AssetService(new MemoryAssetSource(new Map([['a.fake', bytesOf('x')]])));
    const h = svc.request('texture', 'a.fake'); // загрузчика ещё нет
    expect(svc.state(h).status).toBe('failed');

    svc.registerLoader(fakeModelLoader()); // производит 'model', а не 'texture'
    expect(() => { svc.retry(h); }).not.toThrow();
    const s = svc.state(h);
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/нет загрузчика для вида "texture"/);
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
