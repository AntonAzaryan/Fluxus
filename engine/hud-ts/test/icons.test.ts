/**
 * Резолв изображений по asset ID (задача 4.1, HUD-4, design Decision 7):
 * композиция несёт только asset ID дерева контента (ASSET-2), URL появляется
 * лишь из шва `HudIconSource`, который реализует сборка клиента; таблица
 * «идентификатор из симуляции → asset ID» — JSON-данные в params.
 */
import { describe, expect, it } from 'vitest';
import type { HudComposition } from '../src/index.js';
import { assetIdParam, resolveIcon, type HudIconSource } from '../src/icons.js';

/** Шов сборки клиента: записывает запрошенные asset ID — как демо, от корня. */
function spySource(): { source: HudIconSource; requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    source: {
      resolveIconUrl: (assetId) => {
        requested.push(assetId);
        return `/${assetId}`;
      },
    },
  };
}

const table = {
  cast: 'visuals/icons/cast.png',
  jump: 'visuals/icons/jump.png',
};

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
});

describe('резолв — только через шов сборки (HUD-4)', () => {
  it('идентификатор из симуляции даёт URL через инжектированный источник', () => {
    const { source, requested } = spySource();
    expect(resolveIcon(table, source, 'cast')).toBe('/visuals/icons/cast.png');
    // К шву ушёл ровно asset ID из таблицы — никакого собственного корня у HUD.
    expect(requested).toEqual(['visuals/icons/cast.png']);
  });

  it('идентификатор без записи в таблице — ошибка с именем идентификатора', () => {
    const { source } = spySource();
    expect(() => resolveIcon(table, source, 'dodge')).toThrow('"dodge"');
  });
});
