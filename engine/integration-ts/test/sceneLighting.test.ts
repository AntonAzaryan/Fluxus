/**
 * Освещение сцены глазами кросс-слойной сюиты: то, чего не видит ни один пакет
 * по отдельности.
 *
 * Здесь два предмета:
 *
 * 1. **Свет обоих потребителей рендера — из одной подсистемы.** Тождество кадров
 *    вьюпорта редактора и игрового клиента (`editor` ED-22) до сих пор держалось
 *    дисциплиной копирования одинаковых чисел в два файла. Проверка тому, что
 *    чисел этих больше нет, возможна только оттуда, откуда видны оба пакета
 *    сразу, — как и граница контента (CONT-4) и граница инструментов авторинга
 *    (BLND-7).
 * 2. **Сценарии режима теней на собранной сцене (REND-30).** Кэш статики, его
 *    перерисовка событием правки и потолок пресета поверх авторского режима —
 *    свойства не одной подсистемы, а связки «свет + террейн + модели +
 *    контроллер качества» (REND-8, QUAL-1), и собираются они здесь тем же
 *    порядком, каким их собирают сборки.
 *
 * Дерево контента не читается: сцена собирается фикстурой (CONT-4) — эталон
 * освещения обязан краснеть от правки движка, а не от того, что дизайнер
 * подкрутил свет арены.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type EntityId, type TerrainGrid } from '@game-mvp/core';
import type {
  AssetService,
  PresentationLighting,
  VisualManifest,
} from '@game-mvp/assets';
import {
  LightingSubsystem,
  ModelsSubsystem,
  PresentationStage,
  QualityController,
  TerrainSubsystem,
  type EntityView,
  type PresentationProducer,
  type QualityPreset,
  type RenderContext,
} from '@game-mvp/render';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Оба потребителя рендера арены: игровой клиент и вьюпорт редактора. */
const CONSUMERS: readonly { readonly what: string; readonly path: string }[] = [
  { what: 'демо-клиент', path: 'game/demo-ts/app/main.ts' },
  { what: 'вьюпорт редактора', path: 'editor/ui-ts/src/areas/sceneStage.ts' },
];

function sourceOf(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

/**
 * Строки кода без комментариев: обоснование в комментарии вправе называть
 * `AmbientLight` — оно ровно об этом и написано, — а код называть больше не
 * вправе. Разбор грубый (строчные и блочные комментарии), и этого достаточно:
 * `new THREE.AmbientLight(` внутри строкового литерала здесь не бывает.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

describe('ED-22: свет арены — из подсистемы, а не из кода потребителей', () => {
  for (const consumer of CONSUMERS) {
    it(`${consumer.what}: своих источников света не создаёт`, () => {
      const code = codeOf(sourceOf(consumer.path));
      // Дублировать числа света в двух файлах — ровно то, чем тождество кадров
      // держалось раньше; теперь его держит подсистема (REND-8).
      expect(code).not.toContain('AmbientLight');
      expect(code).not.toContain('DirectionalLight');
    });

    it(`${consumer.what}: регистрирует подсистему освещения и включает теневые карты`, () => {
      const code = codeOf(sourceOf(consumer.path));
      expect(code).toContain('LightingSubsystem');
      // Теневые карты включает владелец рендерера, и оба владельца включают их
      // одинаково: кадр вьюпорта обязан быть тем же кадром, а не похожим.
      expect(code).toContain('shadowMap.enabled = true');
      // Тип фильтрации — тот, который рендерер three действительно исполняет:
      // `PCFSoftShadowMap` в `^0.185` устарел и молча подменяется этим же.
      expect(code).toContain('THREE.PCFShadowMap');
      expect(code).not.toContain('THREE.PCFSoftShadowMap');
    });
  }

  it('сцена без секции lighting освещена у обоих потребителей одинаково', () => {
    // Подсистема одна и та же, и это ровно то, что требуется: числа больше не
    // копируются, а выводятся из одного места — из умолчаний конфига.
    const client = new LightingSubsystem({ grid: flatGrid() });
    const viewport = new LightingSubsystem({ grid: flatGrid() });
    expect(client.config).toEqual(viewport.config);
    expect(client.config.shadowMode).toBe('none');

    client.init(contextOf(new THREE.Scene()));
    viewport.init(contextOf(new THREE.Scene()));
    expect(lightNumbers(client)).toEqual(lightNumbers(viewport));
  });
});

// ------------------------------------------------------------------ стенд

const MODEL_ID = 'models/prop.mdx';
const PRODUCER: PresentationProducer = { name: 'integration' };

/** Пустой сервис ассетов: модель не доезжает, и инстанс живёт заглушкой (ASSET-4). */
const NO_ASSETS = {
  registerLoader(): void {},
  request(kind: string, id: string) {
    return { kind, id };
  },
  state() {
    return { status: 'loading' as const };
  },
  subscribe(_handle: unknown, cb: (state: { status: 'loading' }) => void) {
    cb({ status: 'loading' });
    return (): void => {};
  },
  retry(): void {},
} as unknown as AssetService;

const MANIFEST: VisualManifest = {
  entities: { Prop: { model: MODEL_ID } },
  decorations: { Statue: { model: MODEL_ID } },
};

function flatGrid(size = 8): TerrainGrid {
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: 65536,
    levels: Array.from({ length: size }, () => '0'.repeat(size)),
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

function contextOf(scene: THREE.Scene): RenderContext {
  return { scene, assets: NO_ASSETS, config: { heightStep: 0.5 } };
}

/** Числа источников сцены — то, что раньше стояло в коде обоих потребителей. */
function lightNumbers(lighting: LightingSubsystem): unknown {
  const { ambient, sun } = lighting.lights;
  return {
    ambient: [ambient.color.getHexString(), ambient.intensity],
    sun: [sun.color.getHexString(), sun.intensity, sun.position.toArray()],
  };
}

interface Stand {
  readonly stage: PresentationStage;
  readonly lighting: LightingSubsystem;
}

/** Сцена в порядке регистрации сборок (REND-8): свет, террейн, модели. */
function stand(config?: PresentationLighting, preset?: QualityPreset): Stand {
  const stage = new PresentationStage(contextOf(new THREE.Scene()));
  const grid = flatGrid();
  const lighting = new LightingSubsystem({ grid, ...(config === undefined ? {} : { config }) });
  stage.register(lighting);
  stage.register(new TerrainSubsystem(grid, { shadows: lighting }));
  stage.register(new ModelsSubsystem(MANIFEST, { shadows: lighting, warn: () => {} }));
  if (preset !== undefined) new QualityController(stage, preset);
  return { stage, lighting };
}

function view(id: EntityId, kind: string, x: number): EntityView {
  return {
    id,
    kind,
    prevX: x,
    prevY: 0,
    currX: x,
    currY: 0,
    prevLevel: 0,
    currLevel: 0,
    snap: true,
    spawned: false,
    moving: false,
    motion: 0,
    prevMotion: 0,
    prevMotionPhase: Number.NaN,
    currMotionPhase: Number.NaN,
    flightPhase: Number.NaN,
    levelOverride: false,
    facingYaw: 0,
    aimYaw: null,
    states: 0,
  };
}

function tickView(entities: EntityView[]): Parameters<PresentationStage['publish']>[1] {
  return {
    tick: 1,
    mode: 'Running',
    isReplay: false,
    snapAll: false,
    freshEvents: false,
    entities: new Map(entities.map((entity) => [entity.id, entity])),
    statNames: [],
    events: [],
    floorBits: null,
    floorChangedCells: [],
  };
}

function decorationSet(entities: EntityView[]): ReadonlyMap<EntityId, EntityView> {
  return new Map(entities.map((entity) => [entity.id, entity]));
}

// --------------------------------------------------------------- сценарии

describe('гибридный режим на украшенной арене', () => {
  it('статика запекается один раз, а покадрово в карту идёт только динамика', () => {
    const rig = stand({ shadows: { mode: 'hybrid' } });
    // Сотня статичных декораций и двое юнитов — та самая арена, ради которой
    // режим и заведён.
    const statues = Array.from({ length: 100 }, (_, i) => view(1000 + i, 'Statue', i));
    rig.stage.publishDecorations(decorationSet(statues));
    rig.stage.publish(PRODUCER, tickView([view(1, 'Prop', 0), view(2, 'Prop', 1)]));

    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);
    // Каждая статуя — свой инстанс-держатель (модель не доехала, ASSET-4), и
    // все они статические кастеры вместе с чанком террейна.
    expect(rig.lighting.casterCount('static')).toBe(statues.length + 1);
    expect(rig.lighting.casterCount('dynamic')).toBe(2);

    for (let frame = 0; frame < 60; frame++) rig.stage.frame(0.016, 0);
    // Матч идёт, а кэш статики не перерисован ни разу: сто декораций стоят
    // кадру ноль.
    expect(rig.lighting.staticRebuilds).toBe(1);
  });

  it('автор двигает декорацию — кэш перерисован не позже следующего кадра (ED-15)', () => {
    const rig = stand({ shadows: { mode: 'hybrid' } });
    rig.stage.publishDecorations(decorationSet([view(1000, 'Statue', 1)]));
    rig.stage.frame(0.016, 0);
    rig.stage.frame(0.016, 0);
    expect(rig.lighting.staticRebuilds).toBe(1);

    // Правка размещения приходит переподачей набора (REND-18) — тем же входом,
    // которым её видит вьюпорт.
    rig.stage.publishDecorations(decorationSet([view(1000, 'Statue', 7)]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.staticRebuilds).toBe(2);
  });
});

describe('потолок пресета поверх авторского режима (QUAL-1)', () => {
  it('сцена объявляет full, производительный пресет — none: теней нет', () => {
    const authored: PresentationLighting = { shadows: { mode: 'full', mapSize: 2048 } };
    const before = JSON.stringify(authored);
    const rig = stand(authored, { 'lighting.shadowMode': 'none' });
    rig.stage.publish(PRODUCER, tickView([view(1, 'Prop', 0)]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.config.shadowMode).toBe('none');
    expect(rig.lighting.lights.sun.castShadow).toBe(false);
    // Документ сцены пресетом не тронут ни байтом.
    expect(JSON.stringify(authored)).toBe(before);
  });

  it('на ультра-пресете (потолков нет) действует сценный full', () => {
    const rig = stand({ shadows: { mode: 'full', mapSize: 2048 } }, {});
    rig.stage.publish(PRODUCER, tickView([view(1, 'Prop', 0)]));
    rig.stage.frame(0.016, 0);

    expect(rig.lighting.config.shadowMode).toBe('full');
    expect(rig.lighting.config.shadowMapSize).toBe(2048);
    expect(rig.lighting.lights.sun.castShadow).toBe(true);
  });

  it('сбалансированный пресет опускает full до hybrid и режет карту вдвое', () => {
    const rig = stand(
      { shadows: { mode: 'full', mapSize: 2048 } },
      { 'lighting.shadowMode': 'hybrid', 'lighting.shadowMapSize': 1024 },
    );
    expect(rig.lighting.config.shadowMode).toBe('hybrid');
    expect(rig.lighting.config.shadowMapSize).toBe(1024);
    expect(rig.lighting.lights.sun.shadow.mapSize.x).toBe(1024);
  });
});
