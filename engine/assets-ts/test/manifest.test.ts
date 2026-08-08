import { describe, expect, it } from 'vitest';
import { AssetService, manifestLoader, validateManifest } from '../src/index.js';
import { MemoryAssetSource, bytesOf, settled } from './helpers.js';

/** Полноценный валидный визуал — покрывает все поля EntityVisual. */
const validDoc = {
  entities: {
    skeleton: {
      model: 'models/SkeletonBarbarian.mdx',
      scale: 1.8,
      facingDeg: -90,
      defaultSkin: 'bone',
      skins: {
        bone: { '0': 'textures/skeleton.png' },
        forsaken: { '0': 'textures/skeleton_forsaken.png', '2': 'textures/orc.png' },
      },
      animations: {
        states: { idle: 'Stand', move: 'Walk' },
        events: { cast: 'Spell', death: 'Death' },
      },
      boneControls: {
        torso: { bone: 'Bone_Chest', maxYawDeg: 60, smoothing: 0.2 },
        head: { bone: 'Bone_Head', maxYawDeg: 45, smoothing: 0.35 },
      },
      hiddenParts: [3],
    },
    fireball: { model: 'models/Fireball.mdx' },
  },
};

function expectErrors(doc: unknown, ...patterns: RegExp[]): string[] {
  const result = validateManifest(doc);
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

describe('validateManifest (ASSET-6)', () => {
  it('валидный манифест проходит и типизируется', () => {
    const result = validateManifest(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entities['skeleton']!.model).toBe('models/SkeletonBarbarian.mdx');
    expect(result.manifest.entities['fireball']!.model).toBe('models/Fireball.mdx');
  });

  it('минимальная запись — только model — валидна', () => {
    expect(validateManifest({ entities: { x: { model: 'm.mdx' } } }).ok).toBe(true);
  });

  it('не-объект и отсутствие entities — внятные ошибки', () => {
    expectErrors(null, /манифест: ожидался объект.*null/);
    expectErrors([], /манифест: ожидался объект.*массив/);
    expectErrors({}, /entities: обязательное поле/);
    expectErrors({ entities: 42 }, /entities: .*получено number/);
  });

  it('запись сущности: не-объект и отсутствие model — ошибки с путём', () => {
    expectErrors({ entities: { orc: 'oops' } }, /entities\.orc: ожидался объект/);
    expectErrors({ entities: { orc: {} } }, /entities\.orc\.model: обязательное поле/);
    expectErrors({ entities: { orc: { model: '' } } }, /entities\.orc\.model/);
  });

  it('scale: не число и не положительное — ошибки', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', scale: '2' } } },
      /entities\.orc\.scale: .*положительное число/,
    );
    expectErrors({ entities: { orc: { model: 'm.mdx', scale: 0 } } }, /entities\.orc\.scale/);
  });

  it('facingDeg: опционален, любой конечный угол законен, нечисло — ошибка (REND-13)', () => {
    // Поле опционально: запись без него описывает модель по соглашению MDX.
    expect(validateManifest({ entities: { orc: { model: 'm.mdx' } } }).ok).toBe(true);
    // Диапазон не ограничен: угол заворачивается, «-90» и «270» равнозначны.
    for (const facingDeg of [0, -90, 270, 12.5]) {
      expect(
        validateManifest({ entities: { orc: { model: 'm.mdx', facingDeg } } }).ok,
        `угол ${facingDeg} обязан быть законен`,
      ).toBe(true);
    }
    expectErrors(
      { entities: { orc: { model: 'm.mdx', facingDeg: '-90' } } },
      /entities\.orc\.facingDeg: .*получено string/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', facingDeg: Number.NaN } } },
      /entities\.orc\.facingDeg/,
    );
  });

  it('skins: ключ слота не число, значение не строка — ошибки с путём до слота', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', skins: { red: { slot0: 'a.png' } } } } },
      /entities\.orc\.skins\.red: ключ "slot0" не является номером textureSlot/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', skins: { red: { '0': 7 } } } } },
      /entities\.orc\.skins\.red\.0: .*получено number/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', skins: { red: [] } } } },
      /entities\.orc\.skins\.red: ожидался объект/,
    );
  });

  it('defaultSkin без соответствующего скина — ошибка', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', defaultSkin: 'ghost' } } },
      /entities\.orc\.defaultSkin: скин "ghost" не описан/,
    );
    expectErrors(
      {
        entities: {
          orc: { model: 'm.mdx', defaultSkin: 'ghost', skins: { red: { '0': 'a.png' } } },
        },
      },
      /скин "ghost" не описан/,
    );
  });

  it('animations: неизвестная секция и не-строковый клип — ошибки', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', animations: { loops: {} } } } },
      /entities\.orc\.animations\.loops: неизвестное поле/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', animations: { states: { idle: 1 } } } } },
      /entities\.orc\.animations\.states\.idle: .*получено number/,
    );
  });

  it('boneControls: недостающие и невалидные параметры — ошибки с путём до роли', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', boneControls: { torso: { maxYawDeg: 60, smoothing: 0.2 } } } } },
      /entities\.orc\.boneControls\.torso\.bone: обязательное поле/,
    );
    expectErrors(
      {
        entities: {
          orc: {
            model: 'm.mdx',
            boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: -5, smoothing: 0.2 } },
          },
        },
      },
      /entities\.orc\.boneControls\.torso\.maxYawDeg/,
    );
    expectErrors(
      {
        entities: {
          orc: {
            model: 'm.mdx',
            boneControls: { torso: { bone: 'Bone_Chest', maxYawDeg: 5, smoothing: NaN } },
          },
        },
      },
      /entities\.orc\.boneControls\.torso\.smoothing/,
    );
  });

  it('hiddenParts: не массив и не целые >= 0 — ошибки', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', hiddenParts: 3 } } },
      /entities\.orc\.hiddenParts: ожидался массив/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', hiddenParts: [1, -2, 0.5] } } },
      /entities\.orc\.hiddenParts\[1\]/,
      /entities\.orc\.hiddenParts\[2\]/,
    );
  });

  it('неизвестное поле записи — ошибка (опечатки ловятся схемой)', () => {
    expectErrors(
      { entities: { orc: { model: 'm.mdx', defaultSkinn: 'red' } } },
      /entities\.orc\.defaultSkinn: неизвестное поле/,
    );
  });

  it('ошибки собираются все разом, а не по одной', () => {
    const errors = expectErrors({
      entities: {
        a: { model: '' },
        b: { model: 'm.mdx', scale: -1, hiddenParts: 'no' },
      },
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Загрузчик манифеста через сервис (ASSET-6)', () => {
  it('валидный JSON становится ready с типизированным манифестом', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(new Map([['visuals.json', bytesOf(JSON.stringify(validDoc))]])),
    );
    svc.registerLoader(manifestLoader);
    const h = svc.request('manifest', 'visuals.json');
    const s = await settled(svc, h);
    expect(s.status).toBe('ready');
    if (s.status === 'ready') {
      const manifest = s.data as typeof validDoc;
      expect(manifest.entities.skeleton.defaultSkin).toBe('bone');
    }
  });

  it('битый JSON — failed «некорректный JSON»', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(new Map([['visuals.json', bytesOf('{ оборванный')]])),
    );
    svc.registerLoader(manifestLoader);
    const s = await settled(svc, svc.request('manifest', 'visuals.json'));
    expect(s.status).toBe('failed');
    if (s.status === 'failed') expect(s.reason).toMatch(/некорректный JSON/);
  });

  it('невалидная схема — failed с путями до полей', async () => {
    const svc = new AssetService(
      new MemoryAssetSource(
        new Map([['visuals.json', bytesOf(JSON.stringify({ entities: { orc: {} } }))]]),
      ),
    );
    svc.registerLoader(manifestLoader);
    const s = await settled(svc, svc.request('manifest', 'visuals.json'));
    expect(s.status).toBe('failed');
    if (s.status === 'failed') {
      expect(s.reason).toMatch(/не прошёл валидацию/);
      expect(s.reason).toMatch(/entities\.orc\.model/);
    }
  });
});

describe('validateManifest: секция эффектов камеры (ASSET-8)', () => {
  const entities = { x: { model: 'm.mdx' } };

  it('валидная секция проходит; неизвестный тип эффекта — не ошибка валидации', () => {
    const result = validateManifest({
      entities,
      cameraEffects: {
        events: { FireballExploded: { effect: 'shake', amplitude: 0.5, radius: 12 } },
        // Тип из будущего кода камеры: отбраковка — предупреждением на
        // потребителе, манифест валиден (ASSET-8).
        states: { Drunk: { effect: 'wobble-3000', rollAmp: 0.1 } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.cameraEffects!.events!['FireballExploded']!.effect).toBe('shake');
  });

  it('структурные ошибки — внятные, с путями до полей', () => {
    expectErrors({ entities, cameraEffects: 42 }, /cameraEffects: ожидался объект/);
    expectErrors(
      { entities, cameraEffects: { evens: {} } },
      /cameraEffects\.evens: неизвестное поле/,
    );
    expectErrors(
      { entities, cameraEffects: { events: { Boom: {} } } },
      /cameraEffects\.events\.Boom\.effect: обязательное поле/,
    );
    expectErrors(
      { entities, cameraEffects: { events: { Boom: { effect: 'shake', radius: 'far' } } } },
      /cameraEffects\.events\.Boom\.radius: параметр эффекта — конечное число/,
    );
    expectErrors(
      { entities, cameraEffects: { states: 'yes' } },
      /cameraEffects\.states: ожидался объект/,
    );
  });
});

describe('validateManifest: вертикальное смещение инстанса (ASSET-6, REND-12)', () => {
  const entities = { x: { model: 'm.mdx' } };

  it('секция целиком опциональна, поля — по отдельности', () => {
    for (const verticalOffset of [
      { jumpArc: 1.2, fallSpeed: 6, fallDepth: 4 },
      { jumpArc: 0.8 },
      { fallSpeed: 5, fallDepth: 3 },
      {},
    ]) {
      const result = validateManifest({ entities: { x: { model: 'm.mdx', verticalOffset } } });
      expect(result.ok, JSON.stringify(verticalOffset)).toBe(true);
    }
    // Запись без секции — валидна и означает отсутствие смещения (REND-12).
    const bare = validateManifest({ entities });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.manifest.entities['x']!.verticalOffset).toBeUndefined();
  });

  it('отрицательные значения и опечатки — ошибки с путями до полей', () => {
    expectErrors(
      { entities: { x: { model: 'm.mdx', verticalOffset: { jumpArc: -1 } } } },
      /verticalOffset\.jumpArc: ожидалось неотрицательное число/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', verticalOffset: { fallSpeed: 'быстро' } } } },
      /verticalOffset\.fallSpeed: ожидалось неотрицательное число/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', verticalOffset: { fallDeph: 3 } } } },
      /verticalOffset\.fallDeph: неизвестное поле/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', verticalOffset: 1.5 } } },
      /verticalOffset: ожидался объект/,
    );
  });
});
