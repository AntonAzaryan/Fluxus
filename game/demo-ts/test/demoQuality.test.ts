/**
 * Пресеты качества картинки демо (`render-quality` QUAL-1, design D3, D4):
 * три документа приложения против реестра ручек, который собирает СЦЕНА демо,
 * и политика выбора — дефолт, запасной пресет, память о выборе.
 *
 * Механизм проверен в `render-ts` (реестр, потолки, раздача значений); здесь
 * проверяется ПОЛИТИКА игры, которой у движка нет и быть не может: что каждый
 * документ вообще применим к сцене демо (опечатка в имени ручки стоила бы ровно
 * того рычага, ради которого ручка заводилась), что `balanced` повторяет
 * сегодняшнее поведение слово в слово, что `performance` действительно
 * ограничивает, и что отвергнутый документ говорит об этом громко, а не молча
 * оставляет картинку прежней.
 *
 * Сцена собирается headless — тем же набором подсистем, что регистрирует
 * `app/main.ts`: WebGL здесь ни при чём, реестр складывается из деклараций при
 * регистрации (design D1).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@game-mvp/core';
import type { AssetService, PresentationFog, VisualManifest } from '@game-mvp/assets';
import {
  EffectsSubsystem,
  FogSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  validateQualityPreset,
  type QualityValue,
  type RenderContext,
} from '@game-mvp/render';
import {
  DEFAULT_QUALITY_PRESET,
  QUALITY_PRESETS,
  QUALITY_PRESET_NAMES,
  QUALITY_STORAGE_KEY,
  createDemoQuality,
  createQualitySelection,
  qualityPresetName,
  qualityStorageOf,
  rememberQualityPreset,
  storedQualityPreset,
  type QualityPresetName,
  type QualityStorage,
} from '../app/quality.js';
import { STATS } from '../app/sim.js';
import manifestJson from '../../../content/visuals/manifest.json';
import presentationJson from '../../../content/scenes/duel.presentation.json';

/** Манифест визуалов и парный документ сцены — контент демо, читаемый им законно (CONT-4). */
const MANIFEST = manifestJson as unknown as VisualManifest;
const SCENE_FOG = (presentationJson as { fog: PresentationFog }).fog;

/** Ровная арена: реестру ручек размер безразличен, а маска на ней дешевле. */
function flatGrid(size = 8): TerrainGrid {
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: size }, () => '0'.repeat(size)),
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

interface DemoRig {
  readonly stage: PresentationStage;
  readonly fog: FogSubsystem | null;
}

/**
 * Сцена демо без WebGL: тот же набор подсистем и тот же порядок регистрации,
 * что в `onReady` сборки (REND-8). Манифест здесь пустой намеренно — реестр
 * ручек собирается из ДЕКЛАРАЦИЙ подсистем и от данных манифеста не зависит.
 *
 * `fog: false` — сцена без тумана (`SceneDef.fog !== true`): подсистемы тумана
 * в ней нет, и её ручки реестр не объявляет.
 */
function demoContext(): RenderContext {
  return {
    scene: new THREE.Scene(),
    assets: {} as unknown as AssetService,
    config: { heightStep: 0.6 },
  };
}

function demoRig(options: { readonly fog?: boolean } = {}): DemoRig {
  const empty: VisualManifest = { entities: {} };
  const stage = new PresentationStage(demoContext());
  const grid = flatGrid();
  stage.register(new TerrainSubsystem(grid));
  stage.register(new ModelsSubsystem(empty, { warn: () => {} }));
  stage.register(new EffectsSubsystem(empty, { warn: () => {} }));
  stage.register(new ParticlesSubsystem(empty, { warn: () => {} }));
  if (options.fog === false) return { stage, fog: null };
  const fog = new FogSubsystem({
    grid,
    stats: { visionRadius: STATS.visionRadius, team: STATS.team },
    hero: () => null,
    config: SCENE_FOG,
  });
  stage.register(fog);
  return { stage, fog };
}

/**
 * Сцена, у которой нет ни моделей, ни частиц: их ручек реестр не объявляет, и
 * неприменимы ЦЕЛИКОМ оба документа — и `performance`, и запасной `balanced`
 * (QUAL-1). На сцене демо такого не бывает; форма заведена ради контракта —
 * что контроллер называет действующим, когда применить нечего.
 */
function bareStage(): PresentationStage {
  const stage = new PresentationStage(demoContext());
  stage.register(new TerrainSubsystem(flatGrid()));
  return stage;
}

/** Действующие значения ручек как обычный объект — так их удобно сравнивать. */
function effectiveOf(preset: QualityPresetName | null): Record<string, QualityValue> {
  const controller = new QualityController(
    demoRig().stage,
    preset === null ? undefined : QUALITY_PRESETS[preset],
  );
  return Object.fromEntries(controller.effective());
}

describe('документы пресетов применимы к сцене демо (QUAL-1)', () => {
  it('каждый из трёх документов проходит валидацию против собранного реестра', () => {
    const controller = new QualityController(demoRig().stage);
    for (const name of QUALITY_PRESET_NAMES) {
      const result = validateQualityPreset(QUALITY_PRESETS[name], controller.knobs);
      // Причина в сообщении: имя ручки из отказа — это и есть подсказка, что чинить.
      expect(result.ok ? [] : result.errors, name).toEqual([]);
    }
  });

  it('реестр сцены демо — ровно те ручки, о которых написаны документы', () => {
    const controller = new QualityController(demoRig().stage);
    expect(controller.knobs.map((knob) => knob.name).sort()).toEqual([
      'fog.maskResolution',
      'models.defaultTier',
      'models.lodThresholdScale',
      'particles.density',
      'terrain.curvatureTessellation',
    ]);
  });
});

describe('balanced — сегодняшнее поведение слово в слово (design Migration Plan)', () => {
  it('действующие значения те же, что без пресета вовсе: ни одного потолка', () => {
    const withoutPreset = effectiveOf(null);
    expect(effectiveOf('balanced')).toEqual(withoutPreset);
    // Потолок «нет потолка» — бесконечность (QUAL-1): документ его не называет,
    // и назвать не может — диапазон ручки описывает то, что вправе написать
    // автор пресета, а не отсутствие ограничения.
    expect(withoutPreset['fog.maskResolution']).toBe(Number.POSITIVE_INFINITY);
    expect(withoutPreset['terrain.curvatureTessellation']).toBe(Number.POSITIVE_INFINITY);
  });

  it('сценное разрешение маски действует как написано автором (FOW-10)', () => {
    const rig = demoRig();
    expect(rig.fog?.config.resolution).toBe(SCENE_FOG.resolution);

    new QualityController(rig.stage, QUALITY_PRESETS.balanced);

    expect(rig.fog?.config.resolution).toBe(SCENE_FOG.resolution);
  });
});

describe('ultra — авторский потолок как есть (design D4)', () => {
  it('визуально равен balanced: поднимать сегодня нечего', () => {
    expect(effectiveOf('ultra')).toEqual(effectiveOf('balanced'));
  });

  it('потолков нет ни одного: сцена и конфиг рендера действуют как написаны', () => {
    const values = effectiveOf('ultra');
    expect(values['fog.maskResolution']).toBe(Number.POSITIVE_INFINITY);
    expect(values['terrain.curvatureTessellation']).toBe(Number.POSITIVE_INFINITY);
  });

  it('ярус по умолчанию наследует ровно одна запись манифеста — на ней и держится выбор', () => {
    // На этом стоит решение оставить `ultra` равным `balanced`: детальный ярус
    // по умолчанию сменил бы носителя ровно тому, что демо показывает сейчас.
    // Герой детален и так — у записи есть `boneControls` (REND-5), а ярус по
    // умолчанию наследует только декорация `Statue`, своего `tier` (ASSET-13)
    // не назвавшая. Появится в манифесте авторский `tier` — этот тест покажет,
    // что рассуждение в `ultra.json` пора перечитать.
    expect(MANIFEST.entities.Hero?.boneControls).toBeDefined();
    expect(MANIFEST.entities.Hero?.tier).toBeUndefined();
    const inheriting = Object.entries(MANIFEST.decorations ?? {})
      .filter(([, record]) => record.effect === undefined && record.tier === undefined)
      .map(([key]) => key);
    expect(inheriting).toEqual(['Statue']);
  });
});

describe('performance — первые реальные ограничения (QUAL-1, design D3)', () => {
  it('каждая ручка документа действительно ограничивает, а не повторяет умолчание', () => {
    const baseline = effectiveOf('balanced');
    const cheap = effectiveOf('performance');

    // Потолок маски ниже сценных 8 (FOW-10) — вчетверо меньше текселей.
    expect(cheap['fog.maskResolution']).toBeLessThan(SCENE_FOG.resolution ?? 8);
    // Потолок разбиения ниже умолчания конфига рендера 4 (REND-9): потолок,
    // равный действующему значению, не ограничивал бы сегодня ничего.
    expect(cheap['terrain.curvatureTessellation']).toBeLessThan(4);
    // Множитель порогов больше единицы — грубый уровень раньше (REND-22).
    expect(cheap['models.lodThresholdScale']).toBeGreaterThan(
      baseline['models.lodThresholdScale'] as number,
    );
    // Плотность частиц ниже документной (REND-24).
    expect(cheap['particles.density']).toBeLessThan(baseline['particles.density'] as number);
    // Дешёвый носитель закреплён явно, а не унаследован (REND-20).
    expect(cheap['models.defaultTier']).toBe('batched');
  });

  it('сценное разрешение маски ограничивается сверху, документ сцены не трогается', () => {
    const rig = demoRig();
    const before = JSON.stringify(SCENE_FOG);

    new QualityController(rig.stage, QUALITY_PRESETS.performance);

    expect(rig.fog?.config.resolution).toBe(QUALITY_PRESETS.performance['fog.maskResolution']);
    expect(JSON.stringify(SCENE_FOG)).toBe(before);
  });
});

describe('выбор пресета: дефолт, запасной и память (design D4)', () => {
  /** Хранилище-стенд: те же две операции, что демо спрашивает у среды. */
  function fakeStorage(initial?: string): QualityStorage & { readonly items: Map<string, string> } {
    const items = new Map<string, string>();
    if (initial !== undefined) items.set(QUALITY_STORAGE_KEY, initial);
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value);
      },
    };
  }

  it('дефолт — баланс: пустое хранилище и незнакомое имя дают его же', () => {
    expect(DEFAULT_QUALITY_PRESET).toBe('balanced');
    expect(storedQualityPreset(undefined)).toBe('balanced');
    expect(storedQualityPreset(fakeStorage())).toBe('balanced');
    expect(storedQualityPreset(fakeStorage('низкий'))).toBe('balanced');
    expect(qualityPresetName(null)).toBe('balanced');
    expect(qualityPresetName('')).toBe('balanced');
  });

  it('запомненное знакомое имя переживает перезагрузку', () => {
    expect(storedQualityPreset(fakeStorage('performance'))).toBe('performance');
    const storage = fakeStorage();
    rememberQualityPreset(storage, 'ultra');
    expect(storage.items.get(QUALITY_STORAGE_KEY)).toBe('ultra');
    expect(storedQualityPreset(storage)).toBe('ultra');
  });

  it('среда без хранилища — не отказ: в Node его нет вовсе, и выбор просто не помнится', () => {
    expect(qualityStorageOf(globalThis)).toBeUndefined();
    expect(qualityStorageOf(null)).toBeUndefined();
    expect(qualityStorageOf({ localStorage: {} })).toBeUndefined();
    expect(qualityStorageOf({ localStorage: fakeStorage() })).toBeDefined();
    // Запрет доступа хранилищем страницу не роняет.
    const forbidden: QualityStorage = {
      getItem: () => {
        throw new Error('доступ к хранилищу запрещён');
      },
      setItem: () => {
        throw new Error('доступ к хранилищу запрещён');
      },
    };
    expect(storedQualityPreset(forbidden)).toBe('balanced');
    expect(() => {
      rememberQualityPreset(forbidden, 'ultra');
    }).not.toThrow();
  });
});

describe('контроллер качества демо (QUAL-1, design D2)', () => {
  it('выбранный пресет применяется на сборке сцены', () => {
    const rig = demoRig();

    const quality = createDemoQuality(rig.stage, { preset: 'performance' });

    expect(quality.current).toBe('performance');
    expect(rig.fog?.config.resolution).toBe(QUALITY_PRESETS.performance['fog.maskResolution']);
    // Отчёт контроллера показывает ДЕЙСТВУЮЩИЕ значения (design Risks): по нему
    // и видно, что сцена говорит 8, а картинка строится на 4, — и что это
    // пресет, а не потерянное поле документа.
    expect(quality.controller.effective().get('fog.maskResolution')).toBe(
      QUALITY_PRESETS.performance['fog.maskResolution'],
    );
  });

  it('смена пресета идёт живыми подсистемами — пересборки рендера нет', () => {
    const rig = demoRig();
    const quality = createDemoQuality(rig.stage, { preset: 'performance' });
    const fog = rig.fog!;

    expect(quality.select('balanced')).toBe('balanced');

    expect(quality.current).toBe('balanced');
    // Та же подсистема, тот же объект — сменилось только действующее значение.
    expect(rig.fog).toBe(fog);
    expect(fog.config.resolution).toBe(SCENE_FOG.resolution);
  });

  it('документ, отвергнутый реестром, — громкая ошибка и запасной balanced', () => {
    // Сцена без тумана (`SceneDef.fog !== true`): ручки маски реестр не
    // объявлял, и `performance` для такой сцены неприменим целиком (QUAL-1) —
    // молча применить половину документа контроллер не вправе.
    const rig = demoRig({ fog: false });
    const said: string[] = [];

    const quality = createDemoQuality(rig.stage, {
      preset: 'performance',
      warn: (message) => said.push(message),
    });

    expect(quality.current).toBe('balanced');
    expect(said.some((message) => message.includes('fog.maskResolution'))).toBe(true);
    expect(said.some((message) => message.includes('performance'))).toBe(true);
    // Остальные документы отказ соседа не задевает.
    expect(quality.select('ultra')).toBe('ultra');
    expect(quality.select('performance')).toBe('balanced');
  });

  it('отвергнуты и выбранный, и запасной — действующего пресета НЕТ, а не «balanced»', () => {
    // Сцена без моделей и частиц: их ручек реестр не объявлял, и применить
    // нечего — ни выбранный документ, ни запасной.
    const said: string[] = [];

    const quality = createDemoQuality(bareStage(), {
      preset: 'performance',
      warn: (message) => said.push(message),
    });

    // `null`, а не имя запасного: документа `balanced` контроллер не получал, и
    // назвать его действующим значило бы соврать переключателю — тому самому,
    // который обязан показывать применённое. Совпадение сегодняшних умолчаний
    // движка с этим документом — свойство документа, а не обещание.
    expect(quality.current).toBeNull();
    expect(said.some((message) => message.includes('применить нечем'))).toBe(true);
    // Прямой выбор запасного — тот же отказ, и действующего по-прежнему нет.
    expect(quality.select('balanced')).toBeNull();
    expect(quality.current).toBeNull();
  });
});

describe('выбор, сделанный до сборки сцены, доживает до неё (design D2, D4)', () => {
  it('переключение во время загрузки применяет сборка, а не откатывает стартовым', () => {
    const rig = demoRig();
    // Страница поднялась с запомненным `balanced` и грузит манифест, парный
    // документ и ассеты — секунды, за которые человек успевает выбрать уровень.
    const selection = createQualitySelection('balanced');

    // Контроллера ещё нет: применять значения ручек не к чему, выбор ждёт.
    expect(selection.choose('performance')).toBe('performance');
    expect(selection.pending).toBe('performance');

    const quality = selection.attach((preset) => createDemoQuality(rig.stage, { preset }));

    // Сцена собрана ДЕЙСТВУЮЩИМ выбором: соберись она стартовым — переключатель
    // снапнуло бы назад на `balanced`, отменив уже сделанный выбор молча.
    expect(quality.current).toBe('performance');
    expect(selection.pending).toBe('performance');
    expect(rig.fog?.config.resolution).toBe(QUALITY_PRESETS.performance['fog.maskResolution']);
  });

  it('после сборки выбор идёт контроллером — живыми подсистемами', () => {
    const rig = demoRig();
    const selection = createQualitySelection('performance');
    selection.attach((preset) => createDemoQuality(rig.stage, { preset }));

    expect(selection.choose('balanced')).toBe('balanced');

    expect(selection.pending).toBe('balanced');
    expect(rig.fog?.config.resolution).toBe(SCENE_FOG.resolution);
  });

  it('показывается применённое: отвергнутый документ уводит сборку на запасной', () => {
    // Сцена без тумана: `performance` неприменим целиком (QUAL-1).
    const rig = demoRig({ fog: false });
    const selection = createQualitySelection('performance');

    const quality = selection.attach((preset) =>
      createDemoQuality(rig.stage, { preset, warn: () => {} }),
    );

    expect(quality.current).toBe('balanced');
    expect(selection.pending).toBe('balanced');
  });
});
