/**
 * Изображения HUD по asset ID (HUD-4, design Decision 7): композиция несёт
 * только asset ID дерева контента (ASSET-2), а байты за ним приезжают ТЕМ ЖЕ
 * сервисом ассетов, что модели рендера и стенд портрета (HUD-7, ASSET-2..4).
 * Таблица «идентификатор из симуляции → asset ID» — JSON-данные в params.
 */
import { describe, expect, it, vi } from 'vitest';
import { AssetService, type AssetSource, type AssetState } from '@fluxus/assets';
import type { HudComposition } from '../src/index.js';
import {
  HUD_ICON_ASSET_KIND,
  HudIcons,
  assetIdParam,
  iconAssetId,
  type HudIconImage,
} from '../src/icons.js';

const table = {
  cast: 'visuals/icons/cast.png',
  jump: 'visuals/icons/jump.svg',
};

/** Байты «файла» дерева контента — как их отдал бы любой источник сборки. */
const FILES: Readonly<Record<string, Uint8Array>> = {
  'visuals/icons/cast.png': new Uint8Array([1, 2, 3]),
  'visuals/icons/jump.svg': new TextEncoder().encode('<svg/>'),
};

/** Источник байтов, считающий чтения: по нему видно, что кэш ОДИН (ASSET-2). */
function countingSource(): { source: AssetSource; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    source: {
      read: (id: string): Promise<ArrayBuffer> => {
        reads.push(id);
        const bytes = FILES[id];
        if (bytes === undefined) return Promise.reject(new Error(`нет файла "${id}"`));
        return Promise.resolve(bytes.slice().buffer);
      },
    },
  };
}

/** Последнее состояние подписки: тесты смотрят на него, а не на пиксели. */
function watch(icons: HudIcons, assetId: string): AssetState<HudIconImage>[] {
  const states: AssetState<HudIconImage>[] = [];
  icons.subscribe(assetId, (state) => {
    states.push(state);
  });
  return states;
}

describe('asset ID в params — данные контента (HUD-4)', () => {
  it('значение принимается как есть и переживает JSON round-trip', () => {
    expect(assetIdParam('visuals/icons/cast.png', 'запись')).toBe('visuals/icons/cast.png');

    // Композиция с иконками остаётся JSON-значением: переезд на JSON-документ
    // HUD не потребует её переделки (HUD-4, сценарий «Переезд композиции на JSON»).
    const composition: HudComposition = {
      entries: [
        {
          widget: 'cooldowns',
          zone: 'bottom',
          params: { abilities: [{ action: 'cast', icon: table.cast }] },
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(composition))).toEqual(composition);
  });

  it('в композиции нет URL: URL-подобное значение отклоняется с местом записи', () => {
    for (const url of ['https://cdn.example/cast.png', '/visuals/icons/cast.png', 'data:image/png;base64,AAAA']) {
      expect(() => assetIdParam(url, 'запись "cast"')).toThrow('выглядит как URL');
    }
    expect(() => assetIdParam('https://cdn.example/cast.png', 'запись "cast"')).toThrow(
      'запись "cast"',
    );
  });

  it('не-строка и пустое значение — ошибка с местом записи', () => {
    expect(() => assetIdParam(7, 'параметр "icon"')).toThrow('обязан быть строкой');
    expect(() => assetIdParam(undefined, 'параметр "icon"')).toThrow('обязан быть строкой');
    expect(() => assetIdParam('', 'параметр "icon"')).toThrow('пустой asset ID');
  });

  it('идентификатор без записи в таблице — ошибка с именем идентификатора', () => {
    expect(() => iconAssetId(table, 'dodge')).toThrow('"dodge"');
    expect(iconAssetId(table, 'cast')).toBe('visuals/icons/cast.png');
  });
});

describe('иконка резолвится тем же asset-слоем, что у рендера (HUD-4, HUD-7)', () => {
  it('байты приезжают источником сборки и становятся src с MIME формата', async () => {
    const { source, reads } = countingSource();
    const states = watch(new HudIcons(new AssetService(source)), table.jump);

    // Первое состояние — «грузится» (ASSET-4): собственного корня и адреса у
    // HUD нет, файл читает источник сборки.
    expect(states[0]).toEqual({ status: 'loading' });
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe('ready');
    });
    const ready = states.at(-1);
    expect(ready?.status === 'ready' && ready.data.src).toBe(
      `data:image/svg+xml;base64,${btoa('<svg/>')}`,
    );
    expect(reads).toEqual([table.jump]);
  });

  it('второй запрос того же ID не читает файл заново — кэш один (ASSET-2)', async () => {
    const { source, reads } = countingSource();
    const service = new AssetService(source);
    watch(new HudIcons(service), table.cast);
    await vi.waitFor(() => {
      expect(reads).toEqual([table.cast]);
    });

    // Вторая панель поверх ТОГО ЖЕ сервиса — второй загрузки нет.
    const states = watch(new HudIcons(service), table.cast);
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe('ready');
    });
    expect(reads).toEqual([table.cast]);
  });

  it('отсутствующий файл — failed с причиной, а не исключение (ASSET-4)', async () => {
    const { source } = countingSource();
    const states = watch(new HudIcons(new AssetService(source)), 'visuals/icons/missing.png');
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe('failed');
    });
    const failed = states.at(-1);
    expect(failed?.status === 'failed' && failed.reason).toContain('missing.png');
  });

  it('формат без загрузчика вида иконки — failed, а не угаданный MIME (ASSET-3)', async () => {
    const service = new AssetService({
      read: () => Promise.resolve(new Uint8Array([0]).buffer),
    });
    const states = watch(new HudIcons(service), 'visuals/icons/cast.mdx');
    await vi.waitFor(() => {
      expect(states.at(-1)?.status).toBe('failed');
    });
    const failed = states.at(-1);
    expect(failed?.status === 'failed' && failed.reason).toContain(HUD_ICON_ASSET_KIND);
  });
});
