import { describe, expect, it } from 'vitest';
import {
  AssetService,
  DEFAULT_LOD_THRESHOLDS,
  POSITIVE_MIN,
  cameraEffectRangeText,
  clampCameraEffectParam,
  createManifestLoader,
  manifestLoader,
  resolveEffectByEvent,
  resolveEffectByKind,
  resolveLodThresholds,
  resolveVisual,
  resolveVisualTier,
  validateManifest,
  visualKeys,
  type CameraEffectsDescription,
} from '../src/index.js';
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
      tier: 'detailed',
      lodThresholds: [0.3, 0.1],
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
    expect(result.manifest.entities.skeleton!.model).toBe('models/SkeletonBarbarian.mdx');
    expect(result.manifest.entities.fireball!.model).toBe('models/Fireball.mdx');
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

  it('tier и lodThresholds записи: перечень ярусов закрыт, пороги строго убывают (ASSET-13)', () => {
    const ok = validateManifest({
      entities: { orc: { model: 'm.mdx', tier: 'detailed', lodThresholds: [0.3, 0.1] } },
      decorations: { rock: { model: 'r.mdx', tier: 'batched' } },
    });
    expect(ok.ok).toBe(true);

    expectErrors(
      { entities: { orc: { model: 'm.mdx', tier: 'instanced' } } },
      /entities\.orc\.tier: ожидался ярус представления/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', lodThresholds: 0.5 } } },
      /entities\.orc\.lodThresholds: ожидался массив/,
    );
    expectErrors(
      { entities: { orc: { model: 'm.mdx', lodThresholds: [1.5] } } },
      /entities\.orc\.lodThresholds\[0\]: ожидалась доля/,
    );
    // Порог, не меньший предыдущего, дал бы уровень, который не выбирается.
    expectErrors(
      { entities: { orc: { model: 'm.mdx', lodThresholds: [0.2, 0.2] } } },
      /entities\.orc\.lodThresholds\[1\]: пороги должны строго убывать/,
    );
  });

  it('умолчания яруса и порогов: батчевый, детальный — при контроле костей (ASSET-13)', () => {
    const result = validateManifest({
      entities: {
        plain: { model: 'm.mdx' },
        bones: { model: 'm.mdx', boneControls: { torso: { bone: 'b', maxYawDeg: 10, smoothing: 1 } } },
        explicit: {
          model: 'm.mdx',
          tier: 'batched',
          boneControls: { torso: { bone: 'b', maxYawDeg: 10, smoothing: 1 } },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entities = result.manifest.entities;
    expect(resolveVisualTier(entities.plain)).toBe('batched');
    // Процедурному контролю костей нужен настоящий скелет (REND-5).
    expect(resolveVisualTier(entities.bones)).toBe('detailed');
    // Явное поле записи умолчание переопределяет — и в эту сторону тоже.
    expect(resolveVisualTier(entities.explicit)).toBe('batched');
    // Записи без записи вовсе (невизуальный ключ) умолчание тоже касается.
    expect(resolveVisualTier(undefined)).toBe('batched');

    expect(resolveLodThresholds(entities.plain)).toBe(DEFAULT_LOD_THRESHOLDS);
    expect(resolveLodThresholds({ model: 'm.mdx', lodThresholds: [0.4] })).toEqual([0.4]);
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
    expect(result.manifest.cameraEffects!.events!.FireballExploded!.effect).toBe('shake');
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

  /**
   * ASSET-8: набор типов задаётся описанием камеры (CAM-9), и валидация
   * принимает его входом. Описание здесь выдуманное — своего перечня типов у
   * теста быть не должно ровно по той же причине, по какой его нет у модуля
   * ассетов: он разошёлся бы с камерой молча.
   */
  const description: CameraEffectsDescription = {
    types: [
      {
        id: 'shake',
        kind: 'impulse',
        params: [
          { name: 'frequency', defaultValue: 13, min: 0 },
          { name: 'decay', defaultValue: 1.4, min: 0, max: 10 },
        ],
      },
      { id: 'sway', kind: 'lasting', params: [{ name: 'rollAmp', defaultValue: 0.05, min: 0 }] },
    ],
    binding: {
      impulse: [
        { name: 'amplitude', defaultValue: 0.6, min: 0 },
        { name: 'radius', defaultValue: Number.POSITIVE_INFINITY, min: 0 },
      ],
      lasting: [],
    },
  };

  const checked = (section: unknown) =>
    validateManifest({ entities, cameraEffects: section }, { cameraEffects: description });

  it('без описания тип эффекта не проверяется вовсе: своего перечня у валидации нет', () => {
    const result = validateManifest({
      entities,
      cameraEffects: { events: { Boom: { effect: 'wobble-3000', whatever: 1 } } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('неизвестный тип с описанием — предупреждение, а не ошибка (манифест переживает код)', () => {
    const result = checked({ events: { Boom: { effect: 'wobble-3000' } } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/cameraEffects\.events\.Boom\.effect/);
    expect(result.warnings[0]).toMatch(/wobble-3000/);
  });

  it('тип другого вида, чем таблица, и незаявленный параметр — тоже предупреждения', () => {
    const result = checked({
      states: { Drunk: { effect: 'shake' } },
      events: { Boom: { effect: 'shake', loudness: 3 } },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes('Drunk.effect') && w.includes('lasting'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('Boom.loudness'))).toBe(true);
  });

  it('значение вне объявленного диапазона — ошибка с адресом до поля', () => {
    const result = checked({ events: { Boom: { effect: 'shake', decay: 99, amplitude: -1 } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('cameraEffects.events.Boom.decay'))).toBe(true);
    expect(result.errors.some((e) => e.includes('cameraEffects.events.Boom.amplitude'))).toBe(true);
  });

  /**
   * Строгую положительность (CAM-9: «частота положительна») включающая граница
   * выражает наименьшим представимым положительным числом. Сообщение об этом
   * адресовано автору манифеста: `5e-324` в нём — внутренность представления, а
   * не граница, которую автор способен прочесть.
   */
  it('строго положительная граница показана открытым нулём, а не 5e-324', () => {
    const positive: CameraEffectsDescription = {
      types: [{ id: 'shake', kind: 'impulse', params: [{ name: 'frequency', defaultValue: 13, min: POSITIVE_MIN }] }],
      binding: { impulse: [], lasting: [] },
    };
    const result = validateManifest(
      { entities, cameraEffects: { events: { Boom: { effect: 'shake', frequency: 0 } } } },
      { cameraEffects: positive },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain('(0..+∞)');
    expect(result.errors.join()).not.toContain('5e-324');
    // Приведение к границе (CAM-6) при этом остаётся точным по построению:
    // ближе к запрошенному нулю положительное число не подойдёт.
    expect(clampCameraEffectParam({ name: 'frequency', defaultValue: 13, min: POSITIVE_MIN }, 0)).toBe(
      POSITIVE_MIN,
    );
  });

  it('включающие границы записаны закрытыми скобками', () => {
    expect(cameraEffectRangeText({ name: 'decay', defaultValue: 1, min: 0, max: 10 })).toBe('[0..10]');
    expect(cameraEffectRangeText({ name: 'free', defaultValue: 1 })).toBe('(-∞..+∞)');
  });

  it('параметры привязки законны наравне с параметрами типа (CAM-9)', () => {
    const result = checked({ events: { Boom: { effect: 'shake', amplitude: 0.5, radius: 12 } } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('загрузчик с описанием логирует предупреждение и загрузку не роняет (ASSET-4)', async () => {
    const warnings: string[] = [];
    const svc = new AssetService(
      new MemoryAssetSource(
        new Map([
          [
            'visuals.json',
            bytesOf(
              JSON.stringify({
                entities,
                cameraEffects: { events: { Boom: { effect: 'wobble-3000' } } },
              }),
            ),
          ],
        ]),
      ),
    );
    svc.registerLoader(
      createManifestLoader({ cameraEffects: description, warn: (m) => warnings.push(m) }),
    );
    const state = await settled(svc, svc.request('manifest', 'visuals.json'));
    expect(state.status).toBe('ready');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wobble-3000/);
  });
});

/**
 * ASSET-10: секция задаёт ЗНАЧЕНИЯ, состав параметров принадлежит коду камеры
 * (CAM-1) и приезжает описанием — своего перечня у теста нет ровно по той же
 * причине, по какой его нет у модуля ассетов.
 */
describe('validateManifest: секция конфига камеры (ASSET-10)', () => {
  const entities = { x: { model: 'm.mdx' } };
  const description = { params: ['pitch', 'distance', 'effectsMultiplier'] };
  const checked = (section: unknown) =>
    validateManifest({ entities, cameraConfig: section }, { cameraConfig: description });

  it('манифест без секции валиден — камера на умолчаниях кода', () => {
    const result = validateManifest({ entities });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.cameraConfig).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('известные параметры числами проходят и типизируются', () => {
    const result = checked({ pitch: 0.7, distance: 22, effectsMultiplier: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.cameraConfig!.distance).toBe(22);
    expect(result.warnings).toEqual([]);
  });

  it('неизвестный параметр — предупреждение и пропуск, а не ошибка (симметрия с ASSET-8)', () => {
    const result = checked({ pitch: 0.7, wobbliness: 3 });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/cameraConfig\.wobbliness/);
  });

  it('без описания состав параметров не проверяется вовсе: своего перечня у валидации нет', () => {
    const result = validateManifest({ entities, cameraConfig: { wobbliness: 3 } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('нечисловое значение — ошибка на общих основаниях манифеста', () => {
    expectErrors(
      { entities, cameraConfig: { distance: 'далеко' } },
      /cameraConfig\.distance: параметр конфига камеры — конечное число/,
    );
    // Структура секции проверяется одинаково с описанием и без него: иначе один
    // документ был бы валиден у клиента и невалиден у редактора.
    const withDescription = checked({ distance: 'далеко' });
    expect(withDescription.ok).toBe(false);
    expectErrors({ entities, cameraConfig: 42 }, /cameraConfig: ожидался объект/);
    expectErrors({ entities, cameraConfig: { pitch: null } }, /cameraConfig\.pitch/);
  });

  it('опечатка в имени секции ловится схемой манифеста', () => {
    expectErrors({ entities, cameraConfigs: {} }, /манифест\.cameraConfigs: неизвестное поле/);
  });

  it('загрузчик с описанием логирует предупреждение и загрузку не роняет (ASSET-4)', async () => {
    const warnings: string[] = [];
    const svc = new AssetService(
      new MemoryAssetSource(
        new Map([
          [
            'visuals.json',
            bytesOf(JSON.stringify({ entities, cameraConfig: { pitch: 0.7, wobbliness: 3 } })),
          ],
        ]),
      ),
    );
    svc.registerLoader(
      createManifestLoader({ cameraConfig: description, warn: (m) => warnings.push(m) }),
    );
    const state = await settled(svc, svc.request('manifest', 'visuals.json'));
    expect(state.status).toBe('ready');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wobbliness/);
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
    expect(bare.manifest.entities.x!.verticalOffset).toBeUndefined();
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

  it('дуги называются на вид манёвра и на полёт — каждая своим полем (REND-12)', () => {
    const result = validateManifest({
      entities: {
        x: { model: 'm.mdx', verticalOffset: { jumpArc: 0.9, maneuverArc: 0.25, flightArc: 0.35 } },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const offset = result.manifest.entities.x!.verticalOffset!;
    expect(offset.maneuverArc).toBe(0.25);
    expect(offset.flightArc).toBe(0.35);
    // Отсутствие поля — отсутствие дуги этого вида, а не чужая высота.
    expectErrors(
      { entities: { x: { model: 'm.mdx', verticalOffset: { maneuverArc: -0.1 } } } },
      /verticalOffset\.maneuverArc: ожидалось неотрицательное число/,
    );
  });
});

describe('validateManifest: секция транзиентных эффектов (REND-23)', () => {
  const effects = {
    byKind: {
      Fireball: {
        primitive: 'sphere',
        color: '#ff8a3c',
        radius: 0.25,
        alpha: 0.95,
        height: 0.6,
        verticalOffset: { flightArc: 0.35 },
      },
    },
    byEvent: {
      FireballExploded: {
        primitive: 'sphere',
        color: '#ff4020',
        radius: 0.2,
        radiusTo: 1.6,
        alpha: 0.7,
        alphaTo: 0,
        durationMs: 400,
        curve: 'easeOut',
      },
    },
  };

  it('обе таблицы опциональны, записи разрешаются по имени', () => {
    const result = validateManifest({ entities: {}, effects });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveEffectByKind(result.manifest, 'Fireball')!.color).toBe('#ff8a3c');
    expect(resolveEffectByEvent(result.manifest, 'FireballExploded')!.durationMs).toBe(400);
    // Пространства ключей разные: имя события не разрешается как визуальный тип.
    expect(resolveEffectByKind(result.manifest, 'FireballExploded')).toBeUndefined();
    expect(validateManifest({ entities: {} }).ok).toBe(true);
  });

  it('имена примитива и кривой рендеру принадлежат — документ с ними валиден', () => {
    // Перечня примитивов у модуля ассетов нет намеренно (то же, что ASSET-8):
    // неизвестное имя разбирает потребитель, а не валидация формата.
    const result = validateManifest({
      entities: {},
      effects: { byKind: { X: { primitive: 'ribbon', color: '#fff', radius: 1, curve: 'bounce' } } },
    });
    expect(result.ok).toBe(true);
  });

  it('структурные нарушения — ошибки с путями до полей', () => {
    expectErrors(
      { entities: {}, effects: { byKind: { X: { color: '#fff', radius: 1 } } } },
      /effects\.byKind\.X\.primitive: обязательное поле/,
    );
    expectErrors(
      { entities: {}, effects: { byKind: { X: { primitive: 'sphere', color: '#fff' } } } },
      /effects\.byKind\.X\.radius: обязательное поле/,
    );
    expectErrors(
      { entities: {}, effects: { byEvent: { X: { primitive: 'sphere', color: '#fff', radius: 1, alpha: 2 } } } },
      /effects\.byEvent\.X\.alpha: ожидалось число в \[0\.\.1\]/,
    );
    expectErrors(
      { entities: {}, effects: { byKind: { X: { primitive: 'sphere', color: '#fff', radius: 1, radus: 2 } } } },
      /effects\.byKind\.X\.radus: неизвестное поле/,
    );
    expectErrors({ entities: {}, effects: [] }, /effects: ожидался объект/);
  });
});

describe('validateManifest: раздел decoration-видов (ASSET-9)', () => {
  const entities = { rock: { model: 'models/Rock.mdx' } };

  it('вид без prefab\'а валиден и разрешается наравне с записью сущности', () => {
    const result = validateManifest({
      entities,
      decorations: { grass: { model: 'models/Grass.mdx', defaultSkin: 'dry', skins: { dry: { '0': 't.png' } } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Разрешение — одно на оба раздела: потребитель не выбирает раздел сам.
    expect(resolveVisual(result.manifest, 'grass')?.model).toBe('models/Grass.mdx');
    expect(resolveVisual(result.manifest, 'rock')?.model).toBe('models/Rock.mdx');
    expect(resolveVisual(result.manifest, 'nobody')).toBeUndefined();
    expect(visualKeys(result.manifest)).toEqual(['rock', 'grass']);
  });

  it('раздела может не быть вовсе — это манифест без decoration-видов', () => {
    const result = validateManifest({ entities });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.decorations).toBeUndefined();
    expect(visualKeys(result.manifest)).toEqual(['rock']);
  });

  it('имя, занятое в обоих разделах, отвергается — и в причине названо оно', () => {
    const errors = expectErrors(
      { entities, decorations: { rock: { model: 'models/Rock.mdx' } } },
      /decorations\.rock: имя занято записью сущности/,
    );
    expect(errors.join('\n')).toContain('ASSET-9');
  });

  it('состав записи тот же: ошибки адресуются путём внутри раздела', () => {
    expectErrors({ entities, decorations: { grass: {} } }, /decorations\.grass\.model: обязательное поле/);
    expectErrors({ entities, decorations: 7 }, /decorations: ожидался объект/);
    expectErrors(
      { entities, decorations: { grass: { model: 'g.mdx', scal: 2 } } },
      /decorations\.grass\.scal: неизвестное поле/,
    );
  });

  it('неприменимые к decoration части записи валидны и смысла не получают', () => {
    // Таблицы клипов, кости и дуга прыжка производить не от чего (REND-18), но
    // запись одного состава на оба раздела дешевле, чем два состава.
    const result = validateManifest({
      entities,
      decorations: {
        banner: {
          model: 'models/Banner.mdx',
          animations: { states: { idle: 'Stand' }, events: { death: 'Death' } },
          boneControls: { head: { bone: 'Bone_Head', maxYawDeg: 30, smoothing: 0.2 } },
          verticalOffset: { jumpArc: 2, fallSpeed: 5, fallDepth: 3 },
        },
      },
    });
    expect(result.ok).toBe(true);
  });
});
