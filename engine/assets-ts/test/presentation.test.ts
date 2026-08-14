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
