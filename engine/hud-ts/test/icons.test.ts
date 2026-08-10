/**
 * Резолв изображений по asset ID (задача 4.1, HUD-4, design Decision 7):
 * композиция несёт только asset ID дерева контента (ASSET-2), URL появляется
 * лишь из шва `HudIconSource`, который реализует сборка клиента; таблица
 * «идентификатор из симуляции → asset ID» — JSON-данные в params.
 */
import { describe, expect, it } from 'vitest';
import type { HudComposition, HudParams } from '../src/index.js';
import { iconTableFromParams, resolveIcon, type HudIconSource } from '../src/icons.js';

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

const params: HudParams = {
  abilities: ['cast', 'jump'],
  icons: {
    cast: 'visuals/icons/cast.png',
    jump: 'visuals/icons/jump.png',
  },
};

describe('таблица иконок — данные контента в params (HUD-4)', () => {
  it('таблица читается из params и переживает JSON round-trip', () => {
    const table = iconTableFromParams(params, 'icons');
    expect(table).toEqual({ cast: 'visuals/icons/cast.png', jump: 'visuals/icons/jump.png' });

    // Композиция с таблицей остаётся JSON-значением: переезд на JSON-документ
    // HUD не потребует её переделки (HUD-4, сценарий «Переезд композиции на JSON»).
    const composition: HudComposition = {
      entries: [{ widget: 'ability-bar', zone: 'bottom', params }],
    };
    expect(JSON.parse(JSON.stringify(composition))).toEqual(composition);
  });

  it('в композиции нет URL: URL-подобное значение отклоняется с именем записи', () => {
    for (const url of ['https://cdn.example/cast.png', '/visuals/icons/cast.png', 'data:image/png;base64,AAAA']) {
      expect(() => iconTableFromParams({ icons: { cast: url } }, 'icons')).toThrow(
        'выглядит как URL',
      );
    }
    expect(() => iconTableFromParams({ icons: { cast: 'https://cdn.example/cast.png' } }, 'icons')).toThrow(
      'запись "cast"',
    );
  });

  it('не-таблица и не-строковая запись — ошибка с именем параметра', () => {
    expect(() => iconTableFromParams({ icons: 'visuals/icons.png' }, 'icons')).toThrow(
      'параметр "icons"',
    );
    expect(() => iconTableFromParams({}, 'icons')).toThrow('параметр "icons"');
    expect(() => iconTableFromParams({ icons: { cast: 7 } }, 'icons')).toThrow(
      'обязан быть строкой',
    );
    expect(() => iconTableFromParams({ icons: { cast: '' } }, 'icons')).toThrow('пустой asset ID');
  });
});

describe('резолв — только через шов сборки (HUD-4)', () => {
  it('идентификатор из симуляции даёт URL через инжектированный источник', () => {
    const { source, requested } = spySource();
    const table = iconTableFromParams(params, 'icons');
    expect(resolveIcon(table, source, 'cast')).toBe('/visuals/icons/cast.png');
    // К шву ушёл ровно asset ID из таблицы — никакого собственного корня у HUD.
    expect(requested).toEqual(['visuals/icons/cast.png']);
  });

  it('идентификатор без записи в таблице — ошибка с именем идентификатора', () => {
    const { source } = spySource();
    const table = iconTableFromParams(params, 'icons');
    expect(() => resolveIcon(table, source, 'dodge')).toThrow('"dodge"');
  });
});
