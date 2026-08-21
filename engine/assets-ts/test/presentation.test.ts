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
  isPresentationPath,
  presentationLoader,
  presentationPathOf,
  quantizeDecorationLength,
  quantizeDecorationYaw,
  validatePresentationScene,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

function expectErrors(doc: unknown, ...patterns: RegExp[]): string[] {
  const result = validatePresentationScene(doc);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ожидался провал валидации');
  for (const pattern of patterns) {
    expect(
      result.errors.some((e) => pattern.test(e)),
      `нет ошибки под ${pattern}; есть:\n${result.errors.join('\n')}`,
    ).toBe(true);
  }
  return result.errors;
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

  it('режим теней — только объявленные три значения', () => {
    expectErrors(
      { lighting: { shadows: { mode: 'soft' } } },
      /lighting\.shadows\.mode: ожидался режим теней из none \| hybrid \| full/,
    );
    for (const mode of ['none', 'hybrid', 'full']) {
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

describe('PRES-2: секции документа сосуществуют', () => {
  it('секции fog и lighting сосуществуют, и обе — вне симуляции (PRES-4)', () => {
    const result = validatePresentationScene({
      decorations: [{ visual: 'rock', x: 1, y: 2 }],
      fog: { strength: 0.5 },
      lighting: { shadows: { mode: 'hybrid' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.fog).toEqual({ strength: 0.5 });
    expect(result.scene.lighting).toEqual({ shadows: { mode: 'hybrid' } });
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
