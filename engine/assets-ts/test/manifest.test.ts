import { describe, expect, it } from 'vitest';
import {
  AssetService,
  DEFAULT_LIGHT_DECAY,
  DEFAULT_LOD_THRESHOLDS,
  MAX_LIGHT_ANGLE_TURNS,
  POSITIVE_MIN,
  cameraEffectRangeText,
  clampCameraEffectParam,
  createManifestLoader,
  isEmitterVisual,
  manifestLoader,
  resolveEffectByEvent,
  resolveEffectByKind,
  resolveEffectByState,
  resolveEffectsByKind,
  resolveLodThresholds,
  resolveParticlesByEvent,
  resolveParticlesByKind,
  resolveParticlesByState,
  resolveVisual,
  manifestAssetRefs,
  resolveVisualClaim,
  resolveVisualEmitter,
  resolveVisualLight,
  resolveVisualTier,
  validateManifest,
  visualKeys,
  type CameraEffectsDescription,
  type VisualEffect,
} from '../src/index.js';
import { MemoryAssetSource, bytesOf, expectValidationErrors, settled } from './helpers.js';

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

function expectErrors(doc: unknown, ...patterns: RegExp[]): readonly string[] {
  return expectValidationErrors(validateManifest(doc), patterns);
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

describe('validateManifest: блок тинта записи (ASSET-18, REND-40)', () => {
  it('блок целиком опционален, а его поля — по отдельности', () => {
    for (const tint of [
      {},
      { materials: [] },
      { materials: [0, 2] },
      { byEvent: { Damaged: { color: '#ff4040', seconds: 0.18 } } },
      { materials: [1], byEvent: { Damaged: { color: '#ff4040', strength: 0.8, seconds: 0.2 } } },
    ]) {
      const result = validateManifest({ entities: { x: { model: 'm.mdx', tint } } });
      expect(result.ok, JSON.stringify(tint)).toBe(true);
    }
    // Запись без блока валидна и означает отсутствие канала тинта (REND-40).
    const bare = validateManifest({ entities: { x: { model: 'm.mdx' } } });
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;
    expect(bare.manifest.entities.x!.tint).toBeUndefined();
  });

  it('маска — целые неотрицательные индексы материалов модели', () => {
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { materials: [1.5] } } } },
      /tint\.materials\[0\]: ожидался неотрицательный целый индекс материала/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { materials: 2 } } } },
      /tint\.materials: ожидался массив индексов материалов модели/,
    );
  });

  it('вспышка требует цвета и длительности, сила — доля', () => {
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { byEvent: { Damaged: { seconds: 0.2 } } } } } },
      /tint\.byEvent\.Damaged\.color: обязательное поле — цвет формы "#rrggbb"/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { byEvent: { Damaged: { color: '#fff', seconds: 1 } } } } } },
      /tint\.byEvent\.Damaged\.color: обязательное поле — цвет формы "#rrggbb"/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { byEvent: { Damaged: { color: '#ffffff', seconds: 0 } } } } } },
      /tint\.byEvent\.Damaged\.seconds: обязательное поле — длительность вспышки/,
    );
    expectErrors(
      {
        entities: {
          x: { model: 'm.mdx', tint: { byEvent: { Damaged: { color: '#ffffff', strength: 2, seconds: 1 } } } },
        },
      },
      /tint\.byEvent\.Damaged\.strength: ожидалось число в \[0\.\.1\]/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', tint: { byEvnt: {} } } } },
      /tint\.byEvnt: неизвестное поле/,
    );
  });
});

describe('validateManifest: растворение трупа и высота якоря (ASSET-6, REND-4, REND-41)', () => {
  it('блок растворения опционален, длительность обязательна и положительна', () => {
    expect(validateManifest({ entities: { x: { model: 'm.mdx', dissolve: { duration: 1.5 } } } }).ok).toBe(true);
    expect(
      validateManifest({ entities: { x: { model: 'm.mdx', dissolve: { delay: 2, duration: 1 } } } }).ok,
    ).toBe(true);
    expectErrors(
      { entities: { x: { model: 'm.mdx', dissolve: { delay: 2 } } } },
      /dissolve\.duration: обязательное поле — длительность растворения/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', dissolve: { duration: 0 } } } },
      /dissolve\.duration: обязательное поле — длительность растворения/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', dissolve: { delay: -1, duration: 1 } } } },
      /dissolve\.delay: ожидалось неотрицательное число секунд/,
    );
  });

  it('высота якоря — неотрицательное число мировых единиц', () => {
    expect(validateManifest({ entities: { x: { model: 'm.mdx', anchorHeight: 2.4 } } }).ok).toBe(true);
    expectErrors(
      { entities: { x: { model: 'm.mdx', anchorHeight: -1 } } },
      /anchorHeight: ожидалась неотрицательная высота якоря/,
    );
    expectErrors(
      { entities: { x: { model: 'm.mdx', anchorHeigth: 2 } } },
      /anchorHeigth: неизвестное поле/,
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

  it('источник несёт СПИСОК записей, и одна запись остаётся законной формой (REND-23)', () => {
    // Изображений у одного источника бывает несколько — шар снаряда и его след,
    // — и список описывает ровно это. Обе формы валидны: оборачивать одну
    // запись в массив документ не обязан.
    const result = validateManifest({
      entities: {},
      effects: {
        byKind: {
          Fireball: [
            { primitive: 'sphere', color: '#ff8a3c', radius: 0.25 },
            { primitive: 'ribbon', color: '#ffb066', width: 0.2, trailSamples: 8 },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const list = resolveEffectsByKind(result.manifest, 'Fireball');
    expect(Array.isArray(list)).toBe(true);
    expect((list as readonly VisualEffect[]).map((record) => record.primitive)).toEqual([
      'sphere',
      'ribbon',
    ]);
    // Односоставный резолвер отдаёт ПЕРВУЮ запись списка: читателю, которому
    // нужно одно изображение (заглушка модели, REND-37), список ничего не ломает.
    expect(resolveEffectByKind(result.manifest, 'Fireball')!.primitive).toBe('sphere');
  });

  it('пустой список — ошибка: источнику нечего рисовать', () => {
    expectErrors({ entities: {}, effects: { byKind: { X: [] } } }, /список изображений пуст/);
    // Ошибка внутри списка адресуется НОМЕРОМ записи, а не именем источника.
    expectErrors(
      { entities: {}, effects: { byKind: { X: [{ primitive: 'sphere', color: '#fff' }] } } },
      /effects\.byKind\.X\[0\]\.radius: обязательное поле/,
    );
  });

  it('числа формы непроцедурных примитивов — закрытый состав (REND-43)', () => {
    // Перечня примитивов у валидации нет и здесь: она проверяет ЧИСЛА формы и
    // состав ключей, а имя примитива разбирает рендер (REND-23).
    const ok = validateManifest({
      entities: {},
      effects: {
        byKind: {
          Zone: {
            primitive: 'ring',
            color: '#6fd3ff',
            radius: 3,
            innerRadius: 2.5,
            edgeSoftness: 0.4,
            lift: 0.03,
            height: 0,
          },
          Cone: { primitive: 'sector', color: '#fff', radius: 4, halfAngleDeg: 45 },
          Lane: { primitive: 'line', color: '#fff', radius: 0, length: 6, width: 1.2 },
          // Нерадиальный примитив радиуса не несёт вовсе — его признак ширина.
          Link: { primitive: 'beam', color: '#fff', width: 0.4, targetFromStat: 'link' },
          Trail: { primitive: 'ribbon', color: '#fff', width: 0.5, trailSamples: 12 },
        },
      },
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(resolveEffectByKind(ok.manifest, 'Zone')!.innerRadius).toBe(2.5);
    expect(resolveEffectByKind(ok.manifest, 'Link')!.targetFromStat).toBe('link');

    const at = (over: Record<string, unknown>): Record<string, unknown> => ({
      entities: {},
      effects: { byKind: { X: { primitive: 'ring', color: '#fff', radius: 2, ...over } } },
    });
    expectErrors(at({ innerRadius: -1 }), /effects\.byKind\.X\.innerRadius: ожидалось число >= 0/);
    expectErrors(at({ halfAngleDeg: 200 }), /effects\.byKind\.X\.halfAngleDeg: ожидалось число в \[0\.\.180\]/);
    expectErrors(at({ edgeSoftness: 2 }), /effects\.byKind\.X\.edgeSoftness: ожидалось число в \[0\.\.1\]/);
    expectErrors(at({ width: -1 }), /effects\.byKind\.X\.width: ожидалось число >= 0/);
    expectErrors(at({ trailSamples: 1 }), /effects\.byKind\.X\.trailSamples: ожидалось целое число выборок >= 2/);
    expectErrors(at({ targetFromStat: '' }), /effects\.byKind\.X\.targetFromStat: ожидалось имя доставленного стата/);
    expectErrors(at({ lift: 'высоко' }), /effects\.byKind\.X\.lift: ожидалось конечное число/);
    // Радиуса нет и ширины нет — запись не описывает ни радиальный примитив, ни
    // нерадиальный: находка адресная, а не молчание.
    expectErrors(
      { entities: {}, effects: { byKind: { X: { primitive: 'ring', color: '#fff' } } } },
      /effects\.byKind\.X\.radius: обязательное поле/,
    );
  });

  it('мигание без окна стата законно: это пульс луча, а не передержка (REND-23)', () => {
    const result = validateManifest({
      entities: {},
      effects: {
        byKind: {
          Link: {
            primitive: 'beam',
            color: '#fff',
            width: 0.4,
            blink: { periodMs: 200, alpha: 0.5 },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('ведение статом — закрытый состав с адресными находками (REND-23)', () => {
    // Шар заряда каста живёт записью, а не модулем игровой сборки: окно
    // доставленного стата, вынос вперёд, порог цвета и мигание передержки.
    const record = {
      primitive: 'sphere',
      color: '#ff8a3c',
      radius: 0.15,
      alpha: 0.8,
      height: 0.3,
      offset: 0.45,
      radiusFromStat: { stat: 'charge', min: 1, max: 61, from: 1, to: 2 },
      colorAt: { phase: 0.5, color: '#ff7020' },
      blink: { periodMs: 180, alpha: 0.4 },
    };
    const ok = validateManifest({ entities: {}, effects: { byState: { Charging: record } } });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(resolveEffectByState(ok.manifest, 'Charging')!.radiusFromStat!.stat).toBe('charge');
    // Имя стата рендером не проверяется: словарь статов принадлежит сборке
    // воркера (HUD-8), и второй его перечень здесь разошёлся бы молча.
    expect(
      validateManifest({
        entities: {},
        effects: {
          byState: {
            X: { ...record, radiusFromStat: { ...record.radiusFromStat, stat: 'чего-то-нет' } },
          },
        },
      }).ok,
    ).toBe(true);

    const at = (over: Record<string, unknown>): Record<string, unknown> => ({
      entities: {},
      effects: { byState: { X: { ...record, ...over } } },
    });
    expectErrors(
      at({ radiusFromStat: { stat: 'charge', max: 10, to: 2, mn: 1 } }),
      /effects\.byState\.X\.radiusFromStat\.mn: неизвестное поле/,
    );
    expectErrors(
      at({ radiusFromStat: { stat: '', max: 10, to: 2 } }),
      /effects\.byState\.X\.radiusFromStat\.stat: обязательное поле/,
    );
    // Пустое окно — деление на ноль у потребителя; молчаливое приведение к
    // границе спрятало бы опечатку автора.
    expectErrors(
      at({ radiusFromStat: { stat: 'charge', min: 5, max: 5, to: 2 } }),
      /effects\.byState\.X\.radiusFromStat\.max: конец окна/,
    );
    expectErrors(at({ colorAt: { phase: 2, color: '#fff' } }), /colorAt\.phase: обязательное поле/);
    expectErrors(at({ blink: { periodMs: 0, alpha: 0.4 } }), /blink\.periodMs: обязательное поле/);
    expectErrors(at({ offset: 'вперёд' }), /effects\.byState\.X\.offset: ожидалось конечное число/);
    // Порог цвета и мигание без окна привязать не к чему: фазы у записи нет.
    expectErrors(
      {
        entities: {},
        effects: {
          byState: {
            X: { primitive: 'sphere', color: '#fff', radius: 1, colorAt: { phase: 0.5, color: '#000' } },
          },
        },
      },
      /effects\.byState\.X\.colorAt: поле ведётся фазой окна/,
    );
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

describe('validateManifest: секция эмиттеров частиц (ASSET-14)', () => {
  const particles = {
    byKind: {
      Fireball: { effect: 'visuals/effects/trail.effect.json', socket: 'Bone_Tail', scale: 0.5 },
    },
    byState: { Poisoned: { effect: 'visuals/effects/poison.effect.json' } },
    byEvent: { FireballExploded: { effect: 'visuals/effects/boom.effect.json' } },
  };

  it('три таблицы опциональны, записи разрешаются по имени своей секции', () => {
    const result = validateManifest({ entities: {}, particles });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveParticlesByKind(result.manifest, 'Fireball')!.socket).toBe('Bone_Tail');
    expect(resolveParticlesByState(result.manifest, 'Poisoned')!.effect).toBe(
      'visuals/effects/poison.effect.json',
    );
    expect(resolveParticlesByEvent(result.manifest, 'FireballExploded')).toBeDefined();
    // Пространства ключей таблиц разные — как и у секции эффектов (REND-23).
    expect(resolveParticlesByKind(result.manifest, 'Poisoned')).toBeUndefined();
    // Секция опциональна: манифест без частиц валиден и рисуется как раньше.
    expect(validateManifest({ entities: {} }).ok).toBe(true);
  });

  it('запись разрешается по своей секции, не заглядывая в чужую (REND-23)', () => {
    const result = validateManifest({
      entities: {},
      effects: { byKind: { Shield: { primitive: 'sphere', color: '#08f', radius: 1 } } },
      particles: { byKind: { Torchlight: { effect: 'visuals/effects/torch.effect.json' } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveParticlesByKind(result.manifest, 'Shield')).toBeUndefined();
    expect(resolveEffectByKind(result.manifest, 'Torchlight')).toBeUndefined();
  });

  it('состав записи закрыт: неизвестный ключ — ошибка, а не молчаливый игнор', () => {
    expectErrors(
      { entities: {}, particles: { byState: { Poisoned: { effect: 'p.effect.json', socet: 'Head' } } } },
      /particles\.byState\.Poisoned\.socet: неизвестное поле \(допустимы: effect, socket, scale\)/,
    );
    // Числа самого эффекта живут в его документе, а не в записи манифеста.
    expectErrors(
      { entities: {}, particles: { byKind: { X: { effect: 'p.effect.json', startLife: 2 } } } },
      /particles\.byKind\.X\.startLife: неизвестное поле/,
    );
  });

  it('структурные нарушения — ошибки с путями до полей', () => {
    expectErrors(
      { entities: {}, particles: { byKind: { X: { socket: 'Bone' } } } },
      /particles\.byKind\.X\.effect: обязательное поле — asset id эмиттерного ассета/,
    );
    expectErrors(
      { entities: {}, particles: { byKind: { X: { effect: '' } } } },
      /particles\.byKind\.X\.effect/,
    );
    expectErrors(
      { entities: {}, particles: { byEvent: { X: { effect: 'p.effect.json', socket: '' } } } },
      /particles\.byEvent\.X\.socket: ожидалось имя узла-сокета/,
    );
    expectErrors(
      { entities: {}, particles: { byState: { X: { effect: 'p.effect.json', scale: 0 } } } },
      /particles\.byState\.X\.scale: ожидалось положительное число/,
    );
    expectErrors({ entities: {}, particles: { byKind: { X: 'p.effect.json' } } }, /particles\.byKind\.X: ожидался объект/);
    expectErrors({ entities: {}, particles: { byKind: [] } }, /particles\.byKind: ожидался объект «имя → эмиттер»/);
    expectErrors({ entities: {}, particles: { byNothing: {} } }, /particles\.byNothing: неизвестное поле/);
    expectErrors({ entities: {}, particles: [] }, /particles: ожидался объект/);
  });
});

describe('validateManifest: эмиттерный decoration-вид (ASSET-14)', () => {
  const entities = { rock: { model: 'models/Rock.mdx' } };

  it('вид со ссылкой на эффект вместо модели валиден и разрешается своим родом', () => {
    const result = validateManifest({
      entities,
      decorations: {
        torch: { effect: 'visuals/effects/torch.effect.json', scale: 1.5 },
        grass: { model: 'models/Grass.mdx' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveVisualEmitter(result.manifest, 'torch')!.effect).toBe(
      'visuals/effects/torch.effect.json',
    );
    // Подсистеме моделей эмиттерный вид не достаётся: рисует его подсистема
    // частиц (REND-24), а заглушка означала бы «ассет не доехал» (ASSET-4).
    expect(resolveVisual(result.manifest, 'torch')).toBeUndefined();
    expect(resolveVisualEmitter(result.manifest, 'grass')).toBeUndefined();
    expect(resolveVisual(result.manifest, 'grass')?.model).toBe('models/Grass.mdx');
    // Пространство визуальных ключей одно (ASSET-9): размещение ссылается на
    // эмиттерный вид тем же полем `visual`, что на модельный.
    expect(visualKeys(result.manifest)).toEqual(['rock', 'torch', 'grass']);
    expect(isEmitterVisual(result.manifest.decorations!.torch!)).toBe(true);
    expect(isEmitterVisual(result.manifest.decorations!.grass!)).toBe(false);
  });

  it('имя эмиттерного вида в общем пространстве ключей: пересечение отвергается', () => {
    const errors = expectErrors(
      { entities, decorations: { rock: { effect: 'visuals/effects/torch.effect.json' } } },
      /decorations\.rock: имя занято записью сущности/,
    );
    expect(errors.join('\n')).toContain('ASSET-9');
  });

  it('модель и эффект в одной записи взаимоисключающи', () => {
    expectErrors(
      { entities, decorations: { torch: { model: 'models/Torch.mdx', effect: 't.effect.json' } } },
      /decorations\.torch: вид рисуется либо моделью, либо частицами/,
    );
    expectErrors(
      { entities, decorations: { torch: { effect: 42 } } },
      /decorations\.torch\.effect: ожидался asset id эмиттерного ассета/,
    );
  });

  it('эмиттером вправе быть только decoration-вид: эмиттер сущности — секция particles', () => {
    const errors = expectErrors(
      { entities: { fire: { effect: 'visuals/effects/fire.effect.json' } } },
      /entities\.fire\.effect: эмиттерным вправе быть только decoration-вид/,
    );
    expect(errors.join('\n')).toContain('particles');
  });

  it('неприменимые к эмиттеру части записи вида ошибкой не считаются', () => {
    // Скины, клипы и наклон эмиттеру смысла не придают, но и запретом не
    // становятся — то же основание, что у модельного decoration-вида (ASSET-9).
    const result = validateManifest({
      entities,
      decorations: {
        torch: {
          effect: 'visuals/effects/torch.effect.json',
          defaultSkin: 'lit',
          skins: { lit: { '0': 'textures/fire.png' } },
          animations: { states: { idle: 'Stand' } },
          surfaceAlign: { factor: 0.5 },
        },
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateManifest: блок света записи (ASSET-16)', () => {
  const entities = { rock: { model: 'models/Rock.mdx' } };
  const point = { type: 'point', color: '#ffb066', intensity: 12, distance: 6 };

  it('point-блок разбирается в величины рендера: умолчания раскрыты, углы в радианах', () => {
    const result = validateManifest({
      entities: { crystal: { model: 'models/Crystal.mdx', light: { ...point, offset: { z: 1.2 } } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const light = resolveVisualLight(result.manifest, 'crystal');
    expect(light).not.toBeNull();
    expect(light).toMatchObject({
      type: 'point',
      color: '#ffb066',
      intensity: 12,
      distance: 6,
      // Затухание не написано — физическое умолчание блока, а не ноль.
      decay: DEFAULT_LIGHT_DECAY,
      offsetX: 0,
      offsetY: 0,
      offsetZ: 1.2,
      penumbra: 0,
    });
    // Направление по умолчанию — вниз (ASSET-16): point его не читает, но
    // разобранный блок не оставляет полю неопределённого значения.
    expect(light!.directionZ).toBe(-1);
  });

  it('spot-блок: угол долями оборота переводится в радианы, направление нормируется', () => {
    const result = validateManifest({
      entities: {
        lamp: {
          model: 'models/Lamp.mdx',
          light: {
            type: 'spot',
            color: '#ffffff',
            intensity: 20,
            distance: 9,
            decay: 1,
            angle: 0.125,
            penumbra: 0.4,
            direction: { x: 0, y: 3, z: -4 },
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const light = resolveVisualLight(result.manifest, 'lamp')!;
    // Восьмушка оборота — 45°: конверсия живёт на границе разбора (design D4).
    expect(light.angleRad).toBeCloseTo(Math.PI / 4, 12);
    expect(light.penumbra).toBe(0.4);
    expect(light.decay).toBe(1);
    expect(Math.hypot(light.directionX, light.directionY, light.directionZ)).toBeCloseTo(1, 12);
    expect(light.directionY).toBeCloseTo(0.6, 12);
    expect(light.directionZ).toBeCloseTo(-0.8, 12);
  });

  it('свет несёт и эмиттерный decoration-вид: блок — свойство записи, а не изображения', () => {
    // Факел рисуется частицами (ASSET-14, REND-24), а свет несёт наравне со
    // статуей: разрешение блока одно на оба рода записи и оба раздела.
    const result = validateManifest({
      entities,
      decorations: { torch: { effect: 'visuals/effects/torch.effect.json', light: point } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveVisualLight(result.manifest, 'torch')?.intensity).toBe(12);
    // Запись без блока разбирается как прежде — света у неё нет.
    expect(resolveVisualLight(result.manifest, 'rock')).toBeNull();
    expect(resolveVisualLight(result.manifest, 'nobody')).toBeNull();
  });

  it('запись без блока валидна и ничем не отличается от прежней', () => {
    const result = validateManifest(validDoc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveVisualLight(result.manifest, 'skeleton')).toBeNull();
  });

  it('обязательные поля: тип, цвет, положительные интенсивность и граница действия', () => {
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: {} } } },
      /entities\.a\.light\.type: обязательное поле — род источника \(point \| spot\)/,
      /entities\.a\.light\.color: обязательное поле — цвет формы "#rrggbb"/,
      /entities\.a\.light\.intensity: обязательное поле — положительная интенсивность/,
      /entities\.a\.light\.distance: обязательное поле — положительная граница действия/,
    );
    // Вырожденные значения: неположительная интенсивность и нулевая граница.
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, intensity: 0, distance: 0 } } } },
      /entities\.a\.light\.intensity: обязательное поле/,
      /entities\.a\.light\.distance: обязательное поле/,
    );
    // Источника без границы действия не существует (ASSET-16).
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { type: 'point', color: '#fff000', intensity: 3 } } } },
      /entities\.a\.light\.distance: обязательное поле/,
    );
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, color: 'тёплый' } } } },
      /entities\.a\.light\.color: обязательное поле — цвет формы "#rrggbb"/,
    );
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, decay: -1 } } } },
      /entities\.a\.light\.decay: ожидалось неотрицательное затухание/,
    );
    expectErrors({ entities: { a: { model: 'm.mdx', light: 7 } } }, /entities\.a\.light: ожидался объект/);
  });

  it('неизвестный ключ блока отвергается адресно, а не игнорируется молча', () => {
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, radius: 3 } } } },
      /entities\.a\.light\.radius: неизвестное поле/,
    );
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, offset: { x: 1, up: 2 } } } } },
      /entities\.a\.light\.offset\.up: неизвестное поле/,
    );
  });

  it('spot-поле в блоке типа point отвергается: состав закрыт по действующему типу', () => {
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, angle: 0.1 } } } },
      /entities\.a\.light\.angle: поле есть только у источника типа spot/,
    );
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, penumbra: 0.5, direction: { z: -1 } } } } },
      /entities\.a\.light\.penumbra: поле есть только у источника типа spot/,
      /entities\.a\.light\.direction: поле есть только у источника типа spot/,
    );
  });

  it('поле теней отвергается поимённо: локальные источники теней не отбрасывают', () => {
    const errors = expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, castShadow: true } } } },
      /entities\.a\.light\.castShadow: полей теней в блоке света нет и быть не может/,
    );
    expect(errors.join('\n')).toContain('REND-33');
    expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, shadowMapSize: 512 } } } },
      /entities\.a\.light\.shadowMapSize: полей теней в блоке света нет/,
    );
  });

  it('конус: угол обязателен и лежит в (0..0.25] оборота, полутень — в [0..1]', () => {
    const spot = { type: 'spot', color: '#ffffff', intensity: 5, distance: 4 };
    expectErrors(
      { entities, decorations: { lamp: { model: 'm.mdx', light: spot } } },
      /decorations\.lamp\.light\.angle: обязательное поле spot-источника/,
    );
    for (const angle of [0, -0.1, 0.26]) {
      expectErrors(
        { entities, decorations: { lamp: { model: 'm.mdx', light: { ...spot, angle } } } },
        /decorations\.lamp\.light\.angle: обязательное поле spot-источника/,
      );
    }
    expect(MAX_LIGHT_ANGLE_TURNS).toBe(0.25);
    expectErrors(
      { entities, decorations: { lamp: { model: 'm.mdx', light: { ...spot, angle: 0.2, penumbra: 2 } } } },
      /decorations\.lamp\.light\.penumbra: ожидалась полутень конуса в \[0\.\.1\]/,
    );
    // Направление нулевой длины — конусу некуда светить.
    expectErrors(
      {
        entities,
        decorations: {
          lamp: { model: 'm.mdx', light: { ...spot, angle: 0.2, direction: { x: 0, y: 0, z: 0 } } },
        },
      },
      /decorations\.lamp\.light\.direction: направление нулевой длины/,
    );
  });

  it('опечатка в типе не рассыпается находками на каждом поле блока', () => {
    const errors = expectErrors(
      { entities: { a: { model: 'm.mdx', light: { ...point, type: 'pointt', angle: 0.1 } } } },
      /entities\.a\.light\.type: обязательное поле — род источника/,
    );
    expect(errors.some((e) => e.includes('light.angle'))).toBe(false);
  });
});

/**
 * Перечень ссылок манифеста на ассеты — тоже один на репозиторий: по нему
 * правило редактора подсвечивает ссылку в никуда (`editor` ED-14), а проверка
 * контента (`integration-ts`) отбирает документы эффектов и разбирает их
 * (ASSET-14). Вид ссылки назван словарём реестра загрузчиков (ASSET-3), потому
 * что спрашивающему, который ссылку РАЗБИРАЕТ, нужен именно загрузчик.
 */
describe('manifestAssetRefs: где в манифесте лежат ID ассетов (ASSET-6)', () => {
  const parsed = (value: unknown) => {
    const result = validateManifest(value);
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.manifest;
  };

  it('перечисляет модели, текстуры скинов, эмиттеры обеих секций и карту кривизны', () => {
    const refs = manifestAssetRefs(
      parsed({
        entities: {
          Hero: { model: 'visuals/hero.mdx', skins: { red: { '0': 'visuals/hero-red.png' } } },
        },
        decorations: { torch: { effect: 'visuals/effects/torch.effect.json' } },
        particles: { byKind: { Fireball: { effect: 'visuals/effects/trail.effect.json' } } },
        terrain: { curvatureMap: 'visuals/terrain/curvature.json' },
      }),
    );
    expect(refs).toEqual([
      { path: ['entities', 'Hero', 'model'], asset: 'visuals/hero.mdx', kind: 'model' },
      {
        path: ['entities', 'Hero', 'skins', 'red', '0'],
        asset: 'visuals/hero-red.png',
        kind: 'texture',
      },
      {
        path: ['decorations', 'torch', 'effect'],
        asset: 'visuals/effects/torch.effect.json',
        kind: 'particle-effect',
      },
      {
        path: ['particles', 'byKind', 'Fireball', 'effect'],
        asset: 'visuals/effects/trail.effect.json',
        kind: 'particle-effect',
      },
      {
        path: ['terrain', 'curvatureMap'],
        asset: 'visuals/terrain/curvature.json',
        kind: 'terrain-curvature',
      },
    ]);
  });

  it('манифест без ссылок отдаёт пустой перечень, а не бросает', () => {
    expect(manifestAssetRefs(parsed({ entities: {} }))).toEqual([]);
  });

  it('секция эффектов ссылок на ассеты не несёт: её примитивы рисует рендер (REND-23)', () => {
    const refs = manifestAssetRefs(
      parsed({
        entities: {},
        effects: { byKind: { Fireball: { primitive: 'sphere', color: '#f80', radius: 1 } } },
      }),
    );
    expect(refs).toEqual([]);
  });
});

/**
 * Заявка вида (`rendering` REND-37) — один ответ на репозиторий: по нему
 * подсистема моделей решает, ставить ли заглушку, а правило пары редактора
 * (`editor` ED-19) — называть ли prefab без записи рассинхронизацией.
 */
describe('resolveVisualClaim: кто рисует вид без модельной записи (REND-37)', () => {
  const manifest = (extra: Record<string, unknown>): Parameters<typeof resolveVisualClaim>[0] => {
    const result = validateManifest({ entities: { Hero: { model: 'visuals/hero.mdx' } }, ...extra });
    if (!result.ok) throw new Error(result.errors.join('; '));
    return result.manifest;
  };

  it('вид без заявки — null: пустой ответ значит «записи нет» (ASSET-6)', () => {
    expect(resolveVisualClaim(manifest({}), 'Fireball')).toBeNull();
    // Модельная запись заявкой не является: её рисует сама подсистема моделей.
    expect(resolveVisualClaim(manifest({}), 'Hero')).toBeNull();
  });

  it('запись `effects.byKind` заявляет вид за подсистему эффектов (REND-23)', () => {
    const value = manifest({
      effects: { byKind: { Fireball: { primitive: 'sphere', color: '#f80', radius: 1 } } },
    });
    expect(resolveVisualClaim(value, 'Fireball')).toBe('effect');
  });

  it('запись `particles.byKind` заявляет вид за подсистему частиц (REND-24)', () => {
    const value = manifest({
      particles: { byKind: { Torchlight: { effect: 'visuals/effects/torch.effect.json' } } },
    });
    expect(resolveVisualClaim(value, 'Torchlight')).toBe('particles');
  });

  it('эмиттерный decoration-вид заявляет себя сам (ASSET-14)', () => {
    const value = manifest({ decorations: { torch: { effect: 'visuals/effects/torch.effect.json' } } });
    expect(resolveVisualClaim(value, 'torch')).toBe('particles');
  });

  it('вид с обеими заявками отдаётся частицам: объём-прокси положен нарисованному (REND-37)', () => {
    const value = manifest({
      effects: { byKind: { BossFire: { primitive: 'sphere', color: '#f40', radius: 2 } } },
      particles: { byKind: { BossFire: { effect: 'visuals/effects/fire.effect.json' } } },
    });
    expect(resolveVisualClaim(value, 'BossFire')).toBe('particles');
  });

  it('таблицы `byState` и `byEvent` вида заявлять не вправе (REND-37)', () => {
    const value = manifest({
      effects: { byState: { Shielded: { primitive: 'sphere', color: '#08f', radius: 1 } } },
      particles: { byEvent: { Exploded: { effect: 'visuals/effects/boom.effect.json' } } },
    });
    expect(resolveVisualClaim(value, 'Shielded')).toBeNull();
    expect(resolveVisualClaim(value, 'Exploded')).toBeNull();
  });
});

/**
 * ASSET-17: секция путей задаёт ЗНАЧЕНИЯ, состав каналов ключа и перечень
 * сглаживаний принадлежат коду камеры (CAM-10) и приезжают описанием — своего
 * перечня у теста нет по той же причине, по какой его нет у модуля ассетов.
 */
describe('validateManifest: секция путей камеры (ASSET-17)', () => {
  const entities = { x: { model: 'm.mdx' } };
  const description = {
    channels: [
      { name: 'x', required: true },
      { name: 'y', required: true },
      { name: 'distance', required: false, min: 0 },
    ],
    easings: ['linear', 'easeInOut'],
  };
  const checked = (section: unknown) =>
    validateManifest({ entities, cameraPaths: section }, { cameraPaths: description });

  const opener = {
    keys: [
      { x: 0, y: 0, duration: 2, easing: 'easeInOut' },
      { x: 10, y: 4, distance: 20 },
    ],
  };

  it('манифест без секции валиден — путей у сборки просто нет', () => {
    const result = validateManifest({ entities });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.cameraPaths).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('путь из ключей с длительностями и сглаживанием проходит и типизируется', () => {
    const result = checked({ opener });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.cameraPaths!.opener!.keys).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it('незнакомый канал ключа — предупреждение и пропуск (симметрия с ASSET-8, ASSET-10)', () => {
    const result = checked({ p: { keys: [{ x: 0, y: 0, roll: 1 }] } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/cameraPaths\.p\.keys\[0\]\.roll/);
  });

  it('незнакомое сглаживание — предупреждение: будет линейное', () => {
    const result = checked({ p: { keys: [{ x: 0, y: 0, easing: 'бросок' }] } });
    expect(result.ok).toBe(true);
    expect(result.warnings[0]).toMatch(/easing/);
  });

  it('ключ без точки наблюдения — адресный отказ с именем пути и номером ключа', () => {
    const result = checked({ opener: { keys: [{ x: 0, y: 0, duration: 1 }, { y: 4 }] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes('cameraPaths.opener.keys[1].x'))).toBe(true);
  });

  it('структура проверяется строго и без описания: путь без ключей, негодная длительность', () => {
    expectErrors({ entities, cameraPaths: 5 }, /cameraPaths: ожидался объект/);
    expectErrors({ entities, cameraPaths: { p: { keys: [] } } }, /cameraPaths\.p\.keys/);
    expectErrors(
      { entities, cameraPaths: { p: { keys: [{ x: 0, y: 0, duration: 0 }, { x: 1, y: 1 }] } } },
      /cameraPaths\.p\.keys\[0\]\.duration/,
    );
    // Длительность обязательна у всех ключей, кроме последнего: идти после
    // него некуда, а между прочими отрезок существует.
    expectErrors(
      { entities, cameraPaths: { p: { keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } } },
      /keys\[0\]\.duration: длительность/,
    );
    expectErrors({ entities, cameraPaths: { p: { keys: [{ x: 0, y: 0 }], loop: 'да' } } }, /loop/);
    expectErrors({ entities, cameraPaths: { p: { keys: [{ x: 0, y: 'край' }] } } }, /keys\[0\]\.y/);
  });

  it('значение вне границ описания — ошибка, а не предупреждение: границы осмысленности', () => {
    const result = checked({ p: { keys: [{ x: 0, y: 0, distance: -5 }] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatch(/distance/);
  });

  it('без описания состав каналов не проверяется вовсе: своего перечня у валидации нет', () => {
    const result = validateManifest({ entities, cameraPaths: { p: { keys: [{ roll: 1 }] } } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('незнакомый ключ записи пути — ошибка закрытого состава', () => {
    expectErrors({ entities, cameraPaths: { p: { keys: [{ x: 0, y: 0 }], speed: 2 } } }, /speed/);
  });
});
