/**
 * Формат парного presentation-документа сцены (PRES-1, PRES-2, PRES-3): правило
 * имени пары, закрытый состав документа и записи, квантование авторских величин
 * и загрузка документа модулем ассетов (ASSET-3).
 */
import { describe, expect, it } from 'vitest';
import {
  AssetService,
  DECORATION_POSITION_STEP,
  DECORATION_YAW_STEP,
  PRESENTATION_TONE_MAPPING_OPERATORS,
  isPresentationPath,
  presentationLoader,
  presentationPathOf,
  quantizeDecorationLength,
  quantizeDecorationYaw,
  validatePresentationScene,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, expectValidationErrors, settled } from './helpers.js';

function expectErrors(doc: unknown, ...patterns: RegExp[]): readonly string[] {
  return expectValidationErrors(validatePresentationScene(doc), patterns);
}

describe('PRES-1: парность задаётся именем, а не ссылкой', () => {
  it('базовое имя — часть до первой точки, каталог общий', () => {
    expect(presentationPathOf('content/scenes/duel.scene.json')).toBe(
      'content/scenes/duel.presentation.json',
    );
    expect(presentationPathOf('content/scenes/duel.json')).toBe(
      'content/scenes/duel.presentation.json',
    );
    // Переезд сцены переносит и пару: правило имени работает от любого каталога.
    expect(presentationPathOf('arenas/nested/duel.scene.json')).toBe(
      'arenas/nested/duel.presentation.json',
    );
    expect(presentationPathOf('duel.scene.json')).toBe('duel.presentation.json');
    expect(presentationPathOf('duel')).toBe('duel.presentation.json');
  });

  it('у парного документа пары нет — искать её у него не нужно', () => {
    expect(isPresentationPath('content/scenes/duel.presentation.json')).toBe(true);
    expect(isPresentationPath('content/scenes/duel.scene.json')).toBe(false);
  });
});

describe('PRES-2: состав документа и записи закрыт', () => {
  it('валидный документ разбирается и типизируется', () => {
    const result = validatePresentationScene({
      decorations: [
        { visual: 'rock', x: 3.5, y: -2.25 },
        { visual: 'grass', x: 1, y: 1, yaw: 0.125, scale: 1.5, skin: 'dry', walkable: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.decorations).toHaveLength(2);
    expect(result.scene.decorations[1]).toEqual({
      visual: 'grass',
      x: 1,
      y: 1,
      yaw: 0.125,
      scale: 1.5,
      skin: 'dry',
      walkable: true,
    });
  });

  it('walkable — необязательный булев: валидны true, явный false и отсутствие (PRES-2)', () => {
    // Явный false валиден наравне с отсутствием: неразличимость этих двух форм —
    // правило записывающей операции (false не пишется), а не валидации, и файл,
    // написанный руками с `walkable: false`, отвергать не за что (ED-21).
    const result = validatePresentationScene({
      decorations: [
        { visual: 'bridge', x: 0, y: 0, walkable: true },
        { visual: 'bridge', x: 1, y: 1, walkable: false },
        { visual: 'bridge', x: 2, y: 2 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.decorations.map((d) => d.walkable)).toEqual([true, false, undefined]);
  });

  it('небулево значение walkable отвергается адресно (PRES-2)', () => {
    expectErrors(
      { decorations: [{ visual: 'bridge', x: 0, y: 0, walkable: 'yes' }] },
      /decorations\[0\]\.walkable: ожидался булев флаг/,
    );
    // 0/1 Blender-экспорта нормализует импортёр (BLND-3); формату они не булевы.
    expectErrors({ decorations: [{ visual: 'bridge', x: 0, y: 0, walkable: 1 }] }, /decorations\[0\]\.walkable/);
    expectErrors(
      { decorations: [{ visual: 'bridge', x: 0, y: 0, walkable: null }] },
      /decorations\[0\]\.walkable.*null/,
    );
  });

  it('отсутствующий и пустой список неразличимы', () => {
    for (const doc of [{}, { decorations: [] }]) {
      const result = validatePresentationScene(doc);
      expect(result.ok, JSON.stringify(doc)).toBe(true);
      if (!result.ok) return;
      expect(result.scene.decorations).toEqual([]);
    }
  });

  it('порядок записей сохраняется как есть', () => {
    const result = validatePresentationScene({
      decorations: [
        { visual: 'a', x: 0, y: 0 },
        { visual: 'b', x: 0, y: 0 },
        { visual: 'c', x: 0, y: 0 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.decorations.map((d) => d.visual)).toEqual(['a', 'b', 'c']);
  });

  it('неизвестный ключ документа — ошибка, а не молчаливый игнор', () => {
    expectErrors({ lights: [] }, /lights: неизвестное поле/);
    expectErrors(null, /presentation-документ: ожидался объект.*null/);
    expectErrors({ decorations: {} }, /decorations: ожидался список записей/);
  });

  it('сим-поле в записи названо сим-полем, а не опечаткой', () => {
    const errors = expectErrors(
      { decorations: [{ visual: 'rock', x: 0, y: 0, prefab: 'Rock' }] },
      /decorations\[0\]\.prefab: сим-поля в записи decoration нет/,
    );
    expect(errors.join('\n')).toContain('ED-19');
    expectErrors(
      { decorations: [{ visual: 'rock', x: 0, y: 0, overrides: { Pos: { x: 1 } } }] },
      /decorations\[0\]\.overrides: сим-поля в записи decoration нет/,
    );
  });

  it('каждая форма нарушения — своё сообщение и свой адрес записи', () => {
    expectErrors({ decorations: [{ x: 0, y: 0 }] }, /decorations\[0\]\.visual: обязательное поле/);
    expectErrors({ decorations: [{ visual: 'r', y: 0 }] }, /decorations\[0\]\.x: обязательное поле/);
    expectErrors(
      { decorations: [{ visual: 'r', x: 0, y: 0 }, { visual: 'r', x: 'сюда', y: 0 }] },
      /decorations\[1\]\.x: обязательное поле — конечное число/,
    );
    expectErrors(
      { decorations: [{ visual: 'r', x: Number.POSITIVE_INFINITY, y: 0 }] },
      /decorations\[0\]\.x: обязательное поле — конечное число/,
    );
    expectErrors({ decorations: [{ visual: 'r', x: 0, y: 0, yaw: 'вбок' }] }, /decorations\[0\]\.yaw/);
    expectErrors({ decorations: [{ visual: 'r', x: 0, y: 0, skin: '' }] }, /decorations\[0\]\.skin/);
    expectErrors({ decorations: ['камень'] }, /decorations\[0\]: ожидался объект записи/);
  });

  it('масштаб, не превышающий нуля, отвергается адресно (PRES-3)', () => {
    expectErrors(
      { decorations: [{ visual: 'r', x: 0, y: 0, scale: 0 }] },
      /decorations\[0\]\.scale: ожидалось положительное конечное число/,
    );
    expectErrors({ decorations: [{ visual: 'r', x: 0, y: 0, scale: -1 }] }, /decorations\[0\]\.scale/);
    expect(validatePresentationScene({ decorations: [{ visual: 'r', x: 0, y: 0, scale: 0.001 }] }).ok).toBe(
      true,
    );
  });

  it('ошибки собираются все разом, а не по первой', () => {
    const errors = expectErrors({
      decorations: [{ x: 0, y: 0 }, { visual: 'r', x: 'нет', y: 0 }],
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PRES-2, FOW-10: секция fog — закрытая конфигурация рендера тумана', () => {
  it('валидная секция принимается и выходит наружу как есть', () => {
    const fog = {
      strength: 0.65,
      color: '#101623',
      edgeWidth: 2,
      conservatism: 0.92,
      resolution: 4,
      fadeSeconds: 0.45,
      dissolveSeconds: 0.4,
    };
    const result = validatePresentationScene({ decorations: [], fog });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.fog).toEqual(fog);
  });

  it('отсутствие секции — значения по умолчанию у подсистемы: наружу секция не выходит', () => {
    const result = validatePresentationScene({ decorations: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.fog).toBeUndefined();
  });

  it('каждое поле необязательно: частичная секция валидна', () => {
    const result = validatePresentationScene({ fog: { strength: 0.5 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.fog).toEqual({ strength: 0.5 });
  });

  it('неизвестный ключ секции отвергается адресно, а не игнорируется молча (FOW-10)', () => {
    expectErrors({ fog: { strengh: 0.5 } }, /fog\.strengh: неизвестное поле/);
  });

  it('значение не той формы — адресный отказ по каждому полю', () => {
    const errors = expectErrors(
      {
        fog: {
          strength: 2,
          color: 'blue',
          edgeWidth: -1,
          conservatism: 0,
          resolution: 0,
          fadeSeconds: Number.NaN,
          dissolveSeconds: -1,
        },
      },
      /fog\.strength: ожидалась доля затемнения из \[0, 1\]/,
      /fog\.color: ожидался цвет формы "#rrggbb"/,
      /fog\.edgeWidth: ожидалась неотрицательная ширина градиента/,
      /fog\.conservatism: ожидалась доля из \(0, 1\]/,
      /fog\.resolution: ожидалось положительное число текселей/,
      /fog\.fadeSeconds: ожидалась неотрицательная длительность/,
      /fog\.dissolveSeconds: ожидалось неотрицательное время рассеивания/,
    );
    expect(errors).toHaveLength(7);
  });

  it('секция не-объектом отвергается адресно', () => {
    expectErrors({ fog: true }, /fog: ожидался объект секции конфигурации тумана/);
    expectErrors({ fog: [] }, /fog: ожидался объект секции конфигурации тумана.*массив/);
  });
});

describe('PRES-2: секция lighting — закрытая конфигурация освещения сцены', () => {
  it('валидная секция принимается и выходит наружу как есть', () => {
    const lighting = {
      ambient: { color: '#ffffff', intensity: 0.65 },
      directional: { color: '#fff0d0', intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
      shadows: { mode: 'hybrid', mapSize: 1024, staticShare: 0.5 },
    };
    const result = validatePresentationScene({ decorations: [], lighting });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual(lighting);
  });

  it('отсутствие секции — значения по умолчанию у подсистемы: наружу секция не выходит', () => {
    const result = validatePresentationScene({ decorations: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.lighting).toBeUndefined();
  });

  it('каждое поле необязательно: частичная секция валидна', () => {
    const result = validatePresentationScene({ lighting: { shadows: { mode: 'full' } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual({ shadows: { mode: 'full' } });
  });

  it('неизвестный ключ отвергается адресно на КАЖДОМ уровне, а не игнорируется молча', () => {
    expectErrors({ lighting: { ambien: {} } }, /lighting\.ambien: неизвестное поле/);
    expectErrors(
      { lighting: { ambient: { intensivity: 1 } } },
      /lighting\.ambient\.intensivity: неизвестное поле/,
    );
    expectErrors(
      { lighting: { directional: { direction: { w: 1 } } } },
      /lighting\.directional\.direction\.w: неизвестное поле/,
    );
    expectErrors({ lighting: { shadows: { size: 1024 } } }, /lighting\.shadows\.size: неизвестное поле/);
  });

  it('режим теней — только объявленные четыре значения (REND-30)', () => {
    expectErrors(
      { lighting: { shadows: { mode: 'soft' } } },
      /lighting\.shadows\.mode: ожидался режим теней из none \| blob \| hybrid \| full/,
    );
    // Порядок значений нормативен — по нему считается потолок пресета (QUAL-1).
    for (const mode of ['none', 'blob', 'hybrid', 'full']) {
      expect(validatePresentationScene({ lighting: { shadows: { mode } } }).ok).toBe(true);
    }
  });

  it('значение не той формы — адресный отказ по каждому полю', () => {
    const errors = expectErrors(
      {
        lighting: {
          ambient: { color: 'white', intensity: -1 },
          directional: { intensity: Number.NaN, direction: { x: 'далеко' } },
          shadows: { mapSize: 0, staticShare: 2 },
        },
      },
      /lighting\.ambient\.color: ожидался цвет формы "#rrggbb"/,
      /lighting\.ambient\.intensity: ожидалось неотрицательное число интенсивности/,
      /lighting\.directional\.intensity: ожидалось неотрицательное число интенсивности/,
      /lighting\.directional\.direction\.x: ожидалось конечное число мировых единиц/,
      /lighting\.shadows\.mapSize: ожидалось целое положительное число текселей/,
      /lighting\.shadows\.staticShare: ожидалось число из \[0, 1\] — доля интенсивности/,
    );
    expect(errors).toHaveLength(6);
  });

  it('дробная сторона карты теней — не сторона карты', () => {
    expectErrors(
      { lighting: { shadows: { mapSize: 1024.5 } } },
      /lighting\.shadows\.mapSize: ожидалось целое положительное число текселей/,
    );
  });

  it('секция и подсекции не-объектом отвергаются адресно', () => {
    expectErrors({ lighting: true }, /lighting: ожидался объект секции/);
    expectErrors({ lighting: { ambient: 0.5 } }, /lighting\.ambient: ожидался объект секции/);
    expectErrors({ lighting: [] }, /lighting: ожидался объект секции.*массив/);
  });

  it('REND-29: полусферная подсветка и контровой источник — необязательные подсекции', () => {
    const lighting = {
      hemisphere: { skyColor: '#88aaff', groundColor: '#6b5a3a', intensity: 0.5 },
      rim: { color: '#ffe8c0', intensity: 0.8, direction: { x: -6, y: 10, z: 4 } },
    };
    const result = validatePresentationScene({ decorations: [], lighting });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual(lighting);
    // Отсутствие подсекции — отсутствие источника, а не источник с умолчаниями:
    // наружу подсекция не выходит вовсе.
    const bare = validatePresentationScene({ decorations: [], lighting: {} });
    expect(bare.ok && bare.scene.lighting?.hemisphere).toBeUndefined();
    expect(bare.ok && bare.scene.lighting?.rim).toBeUndefined();
  });

  it('REND-29: состав новых подсекций закрыт, значение не той формы — адресный отказ', () => {
    expectErrors(
      { lighting: { hemisphere: { sky: '#ffffff' } } },
      /lighting\.hemisphere\.sky: неизвестное поле \(допустимы: skyColor, groundColor, intensity\)/,
    );
    expectErrors({ lighting: { rim: { falloff: 2 } } }, /lighting\.rim\.falloff: неизвестное поле/);
    const errors = expectErrors(
      {
        lighting: {
          hemisphere: { skyColor: 'небо', groundColor: '#zzz', intensity: -1 },
          rim: { color: 'тепло', direction: { y: Number.POSITIVE_INFINITY } },
        },
      },
      /lighting\.hemisphere\.skyColor: ожидался цвет формы "#rrggbb"/,
      /lighting\.hemisphere\.groundColor: ожидался цвет формы "#rrggbb"/,
      /lighting\.hemisphere\.intensity: ожидалось неотрицательное число интенсивности/,
      /lighting\.rim\.color: ожидался цвет формы "#rrggbb"/,
      /lighting\.rim\.direction\.y: ожидалось конечное число мировых единиц/,
    );
    expect(errors).toHaveLength(5);
    expectErrors({ lighting: { hemisphere: 0.5 } }, /lighting\.hemisphere: ожидался объект секции/);
    expectErrors({ lighting: { rim: [] } }, /lighting\.rim: ожидался объект секции.*массив/);
  });

  it('сцена без подсекции цикла разбирается как прежде: наружу цикл не выходит', () => {
    const lighting = {
      ambient: { intensity: 0.65 },
      directional: { intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
      shadows: { mode: 'full' },
    };
    const result = validatePresentationScene({ decorations: [], lighting });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual(lighting);
    expect(result.scene.lighting?.cycle).toBeUndefined();
  });

});

describe('REND-32: подсекция цикла времени суток — фазы в данных', () => {
  /** Секция с циклом: две фазы, дыры второй закрывает статическая часть. */
  const cycled = {
    ambient: { color: '#ffffff', intensity: 0.65 },
    directional: { color: '#ffffff', intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
    shadows: { mode: 'full' },
    cycle: {
      transitionSeconds: 15,
      phases: [
        {
          name: 'утро',
          seconds: 120,
          ambient: { color: '#ffe8d0', intensity: 0.55 },
          directional: { color: '#ffd9b3', intensity: 1.5, direction: { x: -18, y: -8, z: 7 } },
        },
        { name: 'день', seconds: 120 },
      ],
    },
  };

  it('валидная подсекция принимается и выходит наружу как есть', () => {
    const result = validatePresentationScene({ decorations: [], lighting: cycled });
    expect(result.ok ? '' : result.errors.join('; ')).toBe('');
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual(cycled);
    // Имя фазы — авторская строка, и словаря имён у формата нет: «утро» проходит
    // ровно так же, как «фаза 1» или «morning» (REND-32).
    expect(result.scene.lighting?.cycle?.phases[0]?.name).toBe('утро');
  });

  it('длительность перехода необязательна — умолчание держит подсистема', () => {
    const result = validatePresentationScene({
      lighting: { cycle: { phases: [{ seconds: 10 }, { seconds: 10 }] } },
    });
    expect(result.ok ? '' : result.errors.join('; ')).toBe('');
    if (!result.ok) return;
    expect(result.scene.lighting?.cycle?.transitionSeconds).toBeUndefined();
  });

  it('неизвестный ключ подсекции и фазы отвергается адресно', () => {
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1 }, { seconds: 1 }], loop: true } } },
      /lighting\.cycle\.loop: неизвестное поле \(допустимы: transitionSeconds, phases\)/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1, fog: {} }, { seconds: 1 }] } } },
      /lighting\.cycle\.phases\[0\]\.fog: неизвестное поле/,
    );
    // Адрес называет ФАЗУ индексом, а не подсекцию целиком.
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1 }, { seconds: 1, ambient: { tint: 1 } }] } } },
      /lighting\.cycle\.phases\[1\]\.ambient\.tint: неизвестное поле/,
    );
    expectErrors(
      {
        lighting: {
          cycle: { phases: [{ seconds: 1, directional: { direction: { w: 1 } } }, { seconds: 1 }] },
        },
      },
      /lighting\.cycle\.phases\[0\]\.directional\.direction\.w: неизвестное поле/,
    );
  });

  it('теневые поля в фазе названы поимённо: по кругу они не ходят', () => {
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1, shadows: { mode: 'none' } }, { seconds: 1 }] } } },
      /lighting\.cycle\.phases\[0\]\.shadows: параметров теней в фазе цикла нет и быть не может/,
    );
    for (const key of ['mode', 'mapSize', 'staticShare']) {
      expectErrors(
        { lighting: { cycle: { phases: [{ seconds: 1, [key]: 1 }, { seconds: 1 }] } } },
        new RegExp(`phases\\[0\\]\\.${key}: параметров теней в фазе цикла нет`),
      );
    }
  });

  it('REND-32: фаза ведёт hemisphere и rim по кругу, если они есть у статики', () => {
    const lighting = {
      hemisphere: { skyColor: '#88aaff', groundColor: '#6b5a3a', intensity: 0.5 },
      rim: { color: '#ffe8c0', intensity: 0.8 },
      cycle: {
        transitionSeconds: 5,
        phases: [
          { name: 'день', seconds: 120, hemisphere: { skyColor: '#a0c8ff' } },
          { name: 'ночь', seconds: 120, hemisphere: { intensity: 0.1 }, rim: { intensity: 0 } },
        ],
      },
    };
    const result = validatePresentationScene({ decorations: [], lighting });
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.scene.lighting).toEqual(lighting);
  });

  it('REND-32: фаза не включает источника, которого нет в статической части', () => {
    // Наличие возможности — свойство секции; фаза меняет только числа, и
    // включение источника из ничего отвергается адресно (design D6).
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1, hemisphere: { intensity: 1 } }, { seconds: 1 }] } } },
      /lighting\.cycle\.phases\[0\]\.hemisphere: полусферной подсветки нет в статической части секции/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1 }, { seconds: 1, rim: { intensity: 1 } }] } } },
      /lighting\.cycle\.phases\[1\]\.rim: контрового источника нет в статической части секции/,
    );
    // Пустая подсекция статики источник ЗАВОДИТ (умолчаниями подсистемы), и
    // фаза вправе вести его числа.
    expect(
      validatePresentationScene({
        lighting: {
          hemisphere: {},
          cycle: { phases: [{ seconds: 1, hemisphere: { intensity: 1 } }, { seconds: 1 }] },
        },
      }).ok,
    ).toBe(true);
  });

  it('REND-32: состав фазовых подсекций закрыт тем же перечнем, что у статики', () => {
    expectErrors(
      {
        lighting: {
          hemisphere: {},
          cycle: { phases: [{ seconds: 1, hemisphere: { sky: '#ffffff' } }, { seconds: 1 }] },
        },
      },
      /lighting\.cycle\.phases\[0\]\.hemisphere\.sky: неизвестное поле/,
    );
    expectErrors(
      {
        lighting: {
          rim: {},
          cycle: { phases: [{ seconds: 1 }, { seconds: 1, rim: { color: 'тепло' } }] },
        },
      },
      /lighting\.cycle\.phases\[1\]\.rim\.color: ожидался цвет формы "#rrggbb"/,
    );
  });

  it('вырожденная подсекция отвергается: пустой список, одна фаза, нулевая длительность', () => {
    expectErrors(
      { lighting: { cycle: { phases: [] } } },
      /lighting\.cycle\.phases: фаз 0 — циклу нужно не менее 2/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 120 }] } } },
      /lighting\.cycle\.phases: фаз 1 — циклу нужно не менее 2/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 0 }, { seconds: 120 }] } } },
      /lighting\.cycle\.phases\[0\]\.seconds: обязательное поле — положительная длительность/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 120 }, { seconds: -1 }] } } },
      /lighting\.cycle\.phases\[1\]\.seconds: обязательное поле — положительная длительность/,
    );
    // Длительность обязательна: фаза без неё — не фаза.
    expectErrors(
      { lighting: { cycle: { phases: [{ name: 'утро' }, { seconds: 120 }] } } },
      /lighting\.cycle\.phases\[0\]\.seconds: обязательное поле/,
    );
    expectErrors(
      { lighting: { cycle: { transitionSeconds: -1, phases: [{ seconds: 1 }, { seconds: 1 }] } } },
      /lighting\.cycle\.transitionSeconds: ожидалось неотрицательное число секунд/,
    );
  });

  it('переход не короче слота фазы отвергается: держать облик фазе тогда нечем', () => {
    // Кроссфейд занимает хвост слота, и слот, съеденный им целиком, оставляет
    // фазу без собственного облика — это уже не цикл фаз, а непрерывный дрейф.
    expectErrors(
      { lighting: { cycle: { transitionSeconds: 10, phases: [{ seconds: 10 }, { seconds: 30 }] } } },
      /lighting\.cycle\.transitionSeconds: переход 10 с не короче слота фазы phases\[0\] \(10 с\)/,
    );
    // Находка одна на цикл и называет САМУЮ КОРОТКУЮ фазу: граница проходит по ней.
    const errors = expectErrors(
      {
        lighting: {
          cycle: {
            transitionSeconds: 15,
            phases: [{ seconds: 120 }, { seconds: 12 }, { seconds: 40 }],
          },
        },
      },
      /переход 15 с не короче слота фазы phases\[1\] \(12 с\)/,
    );
    expect(errors).toHaveLength(1);
    // Переход короче самого короткого слота — законная сцена (демо: 15 из 120).
    expect(
      validatePresentationScene({
        lighting: { cycle: { transitionSeconds: 15, phases: [{ seconds: 120 }, { seconds: 16 }] } },
      }).ok,
    ).toBe(true);
    // Нулевой переход — смена фаз скачком: вырождением это не является.
    expect(
      validatePresentationScene({
        lighting: { cycle: { transitionSeconds: 0, phases: [{ seconds: 5 }, { seconds: 5 }] } },
      }).ok,
    ).toBe(true);
  });

  it('подсекция, список фаз и фаза не той формы — адресный отказ', () => {
    expectErrors({ lighting: { cycle: 15 } }, /lighting\.cycle: ожидался объект секции/);
    expectErrors(
      { lighting: { cycle: { phases: { first: {} } } } },
      /lighting\.cycle\.phases: обязательное поле — список фаз цикла/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1 }, 'ночь'] } } },
      /lighting\.cycle\.phases\[1\]: ожидался объект фазы цикла, получено string/,
    );
    expectErrors(
      { lighting: { cycle: { phases: [{ seconds: 1, name: '' }, { seconds: 1 }] } } },
      /lighting\.cycle\.phases\[0\]\.name: ожидалось имя фазы \(непустая строка\)/,
    );
  });

  it('значения света фазы проверяются тем же порядком, что статическая часть', () => {
    const errors = expectErrors(
      {
        lighting: {
          cycle: {
            phases: [
              { seconds: 1, ambient: { color: 'ночной', intensity: -1 } },
              { seconds: 1, directional: { direction: { x: 'далеко' } } },
            ],
          },
        },
      },
      /lighting\.cycle\.phases\[0\]\.ambient\.color: ожидался цвет формы "#rrggbb"/,
      /lighting\.cycle\.phases\[0\]\.ambient\.intensity: ожидалось неотрицательное число интенсивности/,
      /lighting\.cycle\.phases\[1\]\.directional\.direction\.x: ожидалось конечное число мировых единиц/,
    );
    expect(errors).toHaveLength(3);
  });
});

describe('PRES-2, REND-34: секция postprocess — закрытая конфигурация пост-обработки', () => {
  it('валидная секция принимается и выходит наружу как есть', () => {
    const postprocess = {
      toneMapping: { operator: 'aces', exposure: 1.1 },
      bloom: { enabled: true, strength: 0.35, threshold: 1, radius: 0.5 },
    };
    const result = validatePresentationScene({ decorations: [], postprocess });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.postprocess).toEqual(postprocess);
  });

  it('документ без секции разбирается как прежде: наружу секция не выходит', () => {
    const result = validatePresentationScene({ decorations: [{ visual: 'rock', x: 1, y: 2 }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.postprocess).toBeUndefined();
    expect(result.scene.decorations).toHaveLength(1);
  });

  it('каждое поле необязательно: пустая и частичная секции валидны', () => {
    for (const postprocess of [{}, { bloom: { enabled: true } }, { toneMapping: {} }]) {
      const result = validatePresentationScene({ postprocess });
      expect(result.ok, JSON.stringify(postprocess)).toBe(true);
      if (!result.ok) continue;
      expect(result.scene.postprocess).toEqual(postprocess);
    }
  });

  it('каждый оператор закрытого словаря принимается, чужой отвергается адресно', () => {
    for (const operator of PRESENTATION_TONE_MAPPING_OPERATORS) {
      const result = validatePresentationScene({ postprocess: { toneMapping: { operator } } });
      expect(result.ok, operator).toBe(true);
    }
    // Имя оператора three.js, которого в словаре нет: словарь закрыт (REND-34).
    expectErrors(
      { postprocess: { toneMapping: { operator: 'cineon' } } },
      /postprocess\.toneMapping\.operator: ожидался оператор сведения яркости из none \| linear \| reinhard \| aces \| agx \| neutral/,
    );
  });

  it('неизвестный ключ отвергается адресно на КАЖДОМ уровне, а не игнорируется молча', () => {
    expectErrors(
      { postprocess: { toneMappin: {} } },
      /postprocess\.toneMappin: неизвестное поле \(допустимы: toneMapping, bloom, lut\)/,
    );
    expectErrors(
      { postprocess: { toneMapping: { operator: 'aces', gamma: 2.2 } } },
      /postprocess\.toneMapping\.gamma: неизвестное поле/,
    );
    expectErrors(
      { postprocess: { bloom: { enabled: true, knee: 0.5 } } },
      /postprocess\.bloom\.knee: неизвестное поле/,
    );
  });

  it('REND-34: подсекция lut — ID таблицы обязателен, доля применения из [0, 1]', () => {
    const postprocess = { lut: { asset: 'visuals/luts/warm.cube', amount: 0.6 } };
    const result = validatePresentationScene({ decorations: [], postprocess });
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (!result.ok) return;
    expect(result.scene.postprocess).toEqual(postprocess);
    // Доля необязательна: её умолчание — политика подсистемы рендера.
    expect(validatePresentationScene({ postprocess: { lut: { asset: 'a.cube' } } }).ok).toBe(true);
    // Отсутствие подсекции — отсутствие прохода, а не таблица с умолчаниями.
    const bare = validatePresentationScene({ postprocess: {} });
    expect(bare.ok && bare.scene.postprocess?.lut).toBeUndefined();
  });

  it('REND-34: состав подсекции lut закрыт, значение не той формы — адресный отказ', () => {
    expectErrors(
      { postprocess: { lut: { asset: 'a.cube', strength: 1 } } },
      /postprocess\.lut\.strength: неизвестное поле \(допустимы: asset, amount\)/,
    );
    expectErrors(
      { postprocess: { lut: {} } },
      /postprocess\.lut\.asset: обязательное поле — ID ассета таблицы цвета/,
    );
    expectErrors({ postprocess: { lut: { asset: '' } } }, /postprocess\.lut\.asset/);
    expectErrors({ postprocess: { lut: { asset: 12 } } }, /postprocess\.lut\.asset.*number/);
    expectErrors(
      { postprocess: { lut: { asset: 'a.cube', amount: 1.5 } } },
      /postprocess\.lut\.amount: ожидалось число из \[0, 1\] — доля применения таблицы/,
    );
    expectErrors({ postprocess: { lut: { asset: 'a.cube', amount: -0.1 } } }, /postprocess\.lut\.amount/);
    expectErrors({ postprocess: { lut: 'warm.cube' } }, /postprocess\.lut: ожидался объект секции/);
  });

  it('значение не той формы — адресный отказ по каждому полю', () => {
    // Экспозиция строго положительна: нулевая гасит кадр в чёрное, а «сведения
    // нет» выражается оператором `none`, а не числом.
    expectErrors(
      { postprocess: { toneMapping: { exposure: 0 } } },
      /postprocess\.toneMapping\.exposure: ожидалось положительное число экспозиции/,
    );
    expectErrors(
      { postprocess: { toneMapping: { exposure: -1 } } },
      /postprocess\.toneMapping\.exposure/,
    );
    expectErrors({ postprocess: { bloom: { enabled: 'yes' } } }, /postprocess\.bloom\.enabled/);
    expectErrors({ postprocess: { bloom: { strength: -0.1 } } }, /postprocess\.bloom\.strength/);
    expectErrors({ postprocess: { bloom: { threshold: -1 } } }, /postprocess\.bloom\.threshold/);
    // Ширина — доля: и ниже нуля, и выше единицы прочтения у неё нет.
    expectErrors({ postprocess: { bloom: { radius: 1.5 } } }, /postprocess\.bloom\.radius/);
    expectErrors({ postprocess: { bloom: { radius: -0.5 } } }, /postprocess\.bloom\.radius/);
    // Порог, наоборот, верхней границы не имеет: он меряется в линейных
    // значениях ДО сведения, а заяркостный диапазон единицей не ограничен.
    expect(validatePresentationScene({ postprocess: { bloom: { threshold: 12 } } }).ok).toBe(true);
  });

  it('секция и подсекции не-объектом отвергаются адресно', () => {
    expectErrors({ postprocess: 'aces' }, /postprocess: ожидался объект секции, получено string/);
    expectErrors({ postprocess: { bloom: true } }, /postprocess\.bloom: ожидался объект секции/);
    expectErrors(
      { postprocess: { toneMapping: [] } },
      /postprocess\.toneMapping: ожидался объект секции, получено массив/,
    );
  });

  it('ошибки секции собираются все разом, а не по первой', () => {
    const errors = expectErrors({
      postprocess: { toneMapping: { operator: 'filmic', exposure: 0 }, bloom: { radius: 2 } },
    });
    expect(errors).toHaveLength(3);
  });
});

describe('PRES-2: секции документа сосуществуют', () => {
  it('секции fog, lighting, postprocess и water сосуществуют, и все — вне симуляции (PRES-4)', () => {
    const result = validatePresentationScene({
      decorations: [{ visual: 'rock', x: 1, y: 2 }],
      fog: { strength: 0.5 },
      lighting: { shadows: { mode: 'hybrid' } },
      postprocess: { toneMapping: { operator: 'aces' } },
      water: WATER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.fog).toEqual({ strength: 0.5 });
    expect(result.scene.lighting).toEqual({ shadows: { mode: 'hybrid' } });
    expect(result.scene.postprocess).toEqual({ toneMapping: { operator: 'aces' } });
    expect(result.scene.water).toEqual(WATER);
  });
});

// ------------------------------------- секция `water` (REND-35, REND-36)

/** Минимальная валидная секция: карта 4×4 и одно тело обязательного состава. */
const WATER = {
  cells: ['....', '.00.', '.00.', '....'],
  bodies: [{ surfaceLevel: -0.1, shallowColor: '#4db8c4', deepColor: '#16505e' }],
};

/** Сетка сцены глазами валидации: секция воды адресует её клетки (REND-35). */
const GRID = { width: 4, height: 4 };

/** Разбор документа с одной секцией `water`; `grid` не передан — сетка неизвестна. */
function waterResult(
  section: unknown,
  grid?: { width: number; height: number } | null,
): ReturnType<typeof validatePresentationScene> {
  return validatePresentationScene(
    { decorations: [], water: section },
    grid === undefined ? {} : { terrain: grid },
  );
}

function waterErrors(
  section: unknown,
  grid?: { width: number; height: number } | null,
): readonly string[] {
  return expectValidationErrors(waterResult(section, grid), []);
}

function expectWaterError(
  section: unknown,
  pattern: RegExp,
  grid?: { width: number; height: number } | null,
): void {
  expectValidationErrors(waterResult(section, grid), [pattern]);
}

describe('REND-35: состав секции water закрыт и её находки адресны', () => {
  it('валидная секция проходит и с известной сеткой, и без неё', () => {
    expect(validatePresentationScene({ water: WATER }, { terrain: GRID }).ok).toBe(true);
    expect(validatePresentationScene({ water: WATER }).ok).toBe(true);
  });

  it('тело принимает все необязательные блоки: пена, деталь, рябь', () => {
    const rich = {
      cells: WATER.cells,
      bodies: [
        {
          surfaceLevel: 0.5,
          shallowColor: '#4db8c4',
          deepColor: '#16505e',
          maxDepth: 1.5,
          banding: 0,
          foam: { width: 0.2, color: '#ffffff', hardness: 0 },
          detail: {
            source: 'textured',
            layers: 3,
            scale: 4,
            speed: 0.2,
            strength: 0.5,
            normalMap: 'water/normal.png',
            foamNoise: 'water/foam.png',
            flowMap: 'water/flow.png',
          },
          ripples: {
            sources: 12,
            wavelength: 1,
            speed: 2,
            amplitude: 0.4,
            decaySeconds: 2,
            minSpeed: 0.02,
          },
        },
      ],
    };
    expect(validatePresentationScene({ water: rich }, { terrain: GRID }).ok).toBe(true);
  });

  it('символ вне алфавита отвергается с координатой клетки', () => {
    expectWaterError({ ...WATER, cells: ['....', '.0x.', '.00.', '....'] }, /water\.cells\[1\]\[2\].*алфавита/u, GRID);
  });

  it('ряд другой длины отвергается и умолчанием не дополняется', () => {
    expectWaterError({ ...WATER, cells: ['....', '.00.', '.00', '....'] }, /water\.cells\[2\].*длиной 4/u, GRID);
  });

  it('число рядов сверяется с высотой сетки террейна', () => {
    expectWaterError({ ...WATER, cells: ['....', '.00.'] }, /water\.cells: ожидалось 4 рядов/u, GRID);
  });

  it('индекс без тела в bodies отвергается адресно', () => {
    expectWaterError({ ...WATER, cells: ['....', '.03.', '.00.', '....'] }, /water\.cells\[1\]\[2\].*индекс тела 3/u, GRID);
  });

  it('обязательные поля тела: урез и оба цвета', () => {
    expectWaterError({ cells: WATER.cells, bodies: [{}] }, /water\.bodies\[0\]\.surfaceLevel: обязательное/u, GRID);
    expectWaterError({ cells: WATER.cells, bodies: [{}] }, /water\.bodies\[0\]\.shallowColor: обязательное/u, GRID);
    expectWaterError({ cells: WATER.cells, bodies: [{}] }, /water\.bodies\[0\]\.deepColor: обязательное/u, GRID);
  });

  it('отрицательный и дробный урез законны — вода живёт в лощине', () => {
    const deep = { cells: WATER.cells, bodies: [{ ...WATER.bodies[0]!, surfaceLevel: -2.75 }] };
    expect(validatePresentationScene({ water: deep }, { terrain: GRID }).ok).toBe(true);
  });

  it('нечисловое и отрицательное там, где запрещено, отвергается адресно', () => {
    const body = (over: Record<string, unknown>): unknown => ({
      cells: WATER.cells,
      bodies: [{ ...WATER.bodies[0]!, ...over }],
    });
    expectWaterError(body({ surfaceLevel: 'низко' }), /surfaceLevel/u, GRID);
    expectWaterError(body({ maxDepth: 0 }), /maxDepth/u, GRID);
    expectWaterError(body({ banding: -1 }), /banding/u, GRID);
    expectWaterError(body({ banding: 1.5 }), /banding/u, GRID);
    expectWaterError(body({ shallowColor: 'aqua' }), /shallowColor/u, GRID);
    expectWaterError(body({ foam: { width: -1 } }), /foam\.width/u, GRID);
    expectWaterError(body({ foam: { hardness: 2 } }), /foam\.hardness/u, GRID);
    expectWaterError(body({ detail: { source: 'painted' } }), /detail\.source/u, GRID);
    expectWaterError(body({ detail: { layers: 0 } }), /detail\.layers/u, GRID);
    expectWaterError(body({ detail: { normalMap: 7 } }), /detail\.normalMap/u, GRID);
    expectWaterError(body({ ripples: { sources: 17 } }), /ripples\.sources/u, GRID);
    expectWaterError(body({ ripples: { minSpeed: -0.1 } }), /ripples\.minSpeed/u, GRID);
  });

  it('неизвестный ключ секции, тела и блока отвергается с перечнем соседей', () => {
    expectWaterError({ ...WATER, tide: 1 }, /water\.tide: неизвестное поле/u, GRID);
    expectWaterError(
      { cells: WATER.cells, bodies: [{ ...WATER.bodies[0]!, prefab: 'lake' }] },
      /water\.bodies\[0\]\.prefab: неизвестное поле/u,
      GRID,
    );
    expectWaterError(
      { cells: WATER.cells, bodies: [{ ...WATER.bodies[0]!, foam: { thickness: 1 } }] },
      /water\.bodies\[0\]\.foam\.thickness: неизвестное поле/u,
      GRID,
    );
  });

  it('секция при сцене без террейна отвергается целиком', () => {
    expectWaterError(WATER, /секция воды у сцены без террейна/u, null);
  });

  it('карта без списка тел и список не тем типом — находки формы', () => {
    expectWaterError({ cells: WATER.cells }, /water\.bodies: ожидался список/u, GRID);
    expectWaterError({ cells: 'строка', bodies: [] }, /water\.cells: ожидался список/u, GRID);
    expectWaterError({ cells: [1, 2, 3, 4], bodies: [] }, /water\.cells\[0\]: ожидался ряд/u, GRID);
  });

  it('находки собираются все разом, а не по первой', () => {
    const errors = waterErrors({ ...WATER, cells: ['....', '.0x.', '.0y.', '....'] }, GRID);
    expect(errors).toHaveLength(2);
  });

  it('без известной сетки проверяется прямоугольность карты', () => {
    expectWaterError({ ...WATER, cells: ['....', '.00.', '.00', '....'] }, /water\.cells\[2\]/u);
  });
});

describe('PRES-3: квантование записываемого', () => {
  it('позиция и масштаб — к шагу 10⁻³, курс — к 10⁻⁴ оборота', () => {
    expect(DECORATION_POSITION_STEP).toBe(1e-3);
    expect(DECORATION_YAW_STEP).toBe(1e-4);
    expect(quantizeDecorationLength(3.14159)).toBe(3.142);
    expect(quantizeDecorationLength(-2.0004)).toBe(-2);
    expect(quantizeDecorationYaw(0.1234567)).toBe(0.1235);
  });

  it('повторный жест в ту же точку даёт то же число', () => {
    // Ради этого квантование и заведено: без него перетаскивание пишет разряды,
    // не воспроизводимые вторым жестом, и дифф перестаёт быть читаемым.
    const once = quantizeDecorationLength(7.6543219)!;
    expect(quantizeDecorationLength(7.65432188)).toBe(once);
    expect(quantizeDecorationLength(once)).toBe(once);
  });

  it('погрешность не больше половины шага', () => {
    for (const raw of [0.0004, -0.0004, 12.34567, -98.7654321]) {
      expect(Math.abs(quantizeDecorationLength(raw)! - raw)).toBeLessThanOrEqual(
        DECORATION_POSITION_STEP / 2 + 1e-12,
      );
    }
    for (const raw of [0.00004, 0.987654321, -0.5000499]) {
      expect(Math.abs(quantizeDecorationYaw(raw)! - raw)).toBeLessThanOrEqual(
        DECORATION_YAW_STEP / 2 + 1e-12,
      );
    }
  });

  it('нечисловое и бесконечное величиной не становятся', () => {
    expect(quantizeDecorationLength(Number.NaN)).toBeNull();
    expect(quantizeDecorationLength(Number.POSITIVE_INFINITY)).toBeNull();
    expect(quantizeDecorationYaw(Number.NaN)).toBeNull();
  });

  it('минус ноль не заводится: он невидим в JSON, но виден сравнению значений', () => {
    expect(Object.is(quantizeDecorationLength(-0.0001), 0)).toBe(true);
    expect(Object.is(quantizeDecorationYaw(-0.00001), 0)).toBe(true);
  });

  it('квантование не применяется к прочитанному: валидация точность не режет', () => {
    // «Открыл — сохранил» обязан дать байт-в-байт тот же файл (ED-21), поэтому
    // валидация проверяет конечность, а не кратность шагу.
    const written = { decorations: [{ visual: 'r', x: 1.23456789, y: -0.000001 }] };
    const result = validatePresentationScene(written);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.decorations[0]!.x).toBe(1.23456789);
  });
});

describe('PRES-1: документ грузится модулем ассетов (ASSET-3)', () => {
  it('валидный документ приходит handle\'ом ready, битый — failed с причиной', async () => {
    const source = new MemoryAssetSource(
      new Map([
        [
          'content/scenes/duel.presentation.json',
          bytesOf(JSON.stringify({ decorations: [{ visual: 'rock', x: 1, y: 2 }] })),
        ],
        ['content/scenes/broken.presentation.json', bytesOf('{ "decorations": [ { "x": 1 } ] }')],
      ]),
    );
    const service = new AssetService(source);
    service.registerLoader(presentationLoader);

    const good = service.request('presentation', 'content/scenes/duel.presentation.json');
    const bad = service.request('presentation', 'content/scenes/broken.presentation.json');
    await settled(service, good);
    await settled(service, bad);

    const state = service.state(good);
    expect(state.status).toBe('ready');
    const failed = service.state(bad);
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') return;
    expect(failed.reason).toMatch(/decorations\[0\]\.visual/);
  });
});
