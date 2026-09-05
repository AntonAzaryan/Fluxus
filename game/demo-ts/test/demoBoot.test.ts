/**
 * Документ старта, который демо ОТГРУЖАЕТ (`app/boot/boot.json`), против
 * реестра его собственной сборки (`game-boot` BOOT-3).
 *
 * Механизм проверен рядом (`bootDocument.test.ts` — словарь, умолчания, адресный
 * отказ); здесь — ПОЛИТИКА: что отгружаемый документ вообще применим к сцене
 * демо. Опечатка в имени стадии стоила бы ровно того прогрева, ради которого
 * стадия написана, а забытая стадия — молчаливого «объявлена, но не прогрета».
 *
 * Сцена собирается headless — тем же набором подсистем и в том же порядке, что
 * регистрирует `app/main.ts`: WebGL здесь ни при чём, реестр стадий
 * складывается из точек прогрева при регистрации (REND-45).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_ONE, createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import type { AssetService, PresentationFog, VisualManifest } from '@fluxus/assets';
import {
  EffectsSubsystem,
  FogSubsystem,
  LightingSubsystem,
  ModelsSubsystem,
  ParticlesSubsystem,
  PostprocessSubsystem,
  PresentationStage,
  TerrainSubsystem,
  WaterSubsystem,
  type RenderContext,
  type RenderSubsystem,
} from '@fluxus/render';
import bootJson from '../app/boot/boot.json';
import { notWarmedStages, resolveBootDocument } from '../app/boot/bootDocument.js';
import { DEMO_DECLARABLE_SUBSYSTEMS } from '../app/quality.js';
import { STATS } from '../app/sim.js';
import presentationJson from '../../../content/scenes/duel.presentation.json';

const SCENE_FOG = (presentationJson as { fog: PresentationFog }).fog;

/** Ровная арена: реестру стадий размер безразличен. */
function flatGrid(size = 8): TerrainGrid {
  return createTerrainGrid({
    width: size,
    height: size,
    tileSize: FIXED_ONE,
    levels: Array.from({ length: size }, () => '0'.repeat(size)),
    flags: Array.from({ length: size }, () => '.'.repeat(size)),
  });
}

function demoContext(): RenderContext {
  const assets = {
    request: (kind: string, id: string) => ({ kind, id }),
    state: () => ({ status: 'loading' }),
    subscribe: () => () => {},
  } as unknown as AssetService;
  return { scene: new THREE.Scene(), assets, config: { heightStep: 0.6 } };
}

/**
 * Подсистемы сцены демо в порядке регистрации `onReady` (REND-8). `fog: false`
 * — сцена без тумана (`SceneDef.fog !== true`): подсистемы тумана в ней нет, и
 * стадию `prewarm.fog` документ несёт про СБОРКУ, а не про эту сцену.
 */
function demoStage(options: { readonly fog?: boolean } = {}): PresentationStage {
  const empty: VisualManifest = { entities: {} };
  const stage = new PresentationStage(demoContext());
  const grid = flatGrid();
  const postprocess = new PostprocessSubsystem({});
  stage.register(postprocess);
  const lighting = new LightingSubsystem({ grid });
  stage.register(lighting);
  stage.register(new TerrainSubsystem(grid, { shadows: lighting }));
  stage.register(new WaterSubsystem({ grid }));
  stage.register(new ModelsSubsystem(empty, { shadows: lighting, warn: () => {} }));
  stage.register(new EffectsSubsystem(empty, { warn: () => {} }));
  stage.register(new ParticlesSubsystem(empty, { warn: () => {} }));
  if (options.fog === false) return stage;
  stage.register(
    new FogSubsystem({
      grid,
      stats: { visionRadius: STATS.visionRadius, team: STATS.team },
      hero: () => null,
      config: SCENE_FOG,
      post: postprocess,
    }),
  );
  return stage;
}

/** Реестр стадий сборки — тем же обходом регистраций, что в `main.ts` (REND-45). */
function declaredStages(stage: PresentationStage): Set<string> {
  const declared = new Set<string>();
  stage.watchRegistrations((subsystem: RenderSubsystem) => {
    if (subsystem.prewarm !== undefined) declared.add(subsystem.name);
  });
  return declared;
}

const DESTINATIONS = new Set(['scene']);

describe('документ старта демо применим к его сцене (BOOT-3, BOOT-1)', () => {
  it('на сцене с туманом — ни одной ошибки и ни одной не прогретой стадии', () => {
    const declared = declaredStages(demoStage());
    const plan = resolveBootDocument(bootJson, {
      declared,
      declarable: DEMO_DECLARABLE_SUBSYSTEMS,
      destinations: DESTINATIONS,
    });
    expect(plan.rejected).toEqual([]);
    // Каждая объявившая точку прогрева подсистема названа документом: молчаливо
    // не прогретых нет (BOOT-3).
    expect(plan.notWarmed).toEqual([]);
    expect(plan.document.after).toBe('scene');
    expect(plan.document.warmFrames).toBeGreaterThan(0);
  });

  it('реестр сборки — те же четыре подсистемы, что называет документ', () => {
    // Второго списка имён подсистем нет (REND-45): имя стадии есть имя
    // подсистемы, и разойтись эти два перечня могут только вместе.
    expect([...declaredStages(demoStage())].sort()).toEqual([
      'effects',
      'fog',
      'models',
      'particles',
    ]);
  });

  it('на сцене без тумана документ тоже принят: `fog` — объявляемый владелец (QUAL-1)', () => {
    const declared = declaredStages(demoStage({ fog: false }));
    const plan = resolveBootDocument(bootJson, {
      declared,
      declarable: DEMO_DECLARABLE_SUBSYSTEMS,
      destinations: DESTINATIONS,
    });
    expect(plan.rejected).toEqual([]);
    expect(plan.notWarmed).toEqual([]);
    // Перечень объявляемых — ТОТ ЖЕ, что у пресетов качества: второго списка
    // владельцев сборка не заводит.
    expect(DEMO_DECLARABLE_SUBSYSTEMS).toContain('fog');
    expect(notWarmedStages(plan.document, declared)).toEqual([]);
  });

  it('стадии идут в порядке своих входов: прогрев между handshake и сценой', () => {
    const plan = resolveBootDocument(bootJson, {
      declared: declaredStages(demoStage()),
      declarable: DEMO_DECLARABLE_SUBSYSTEMS,
      destinations: DESTINATIONS,
    });
    expect(plan.document.stages.map((stage) => stage.name)).toEqual([
      'handshake',
      'prewarm.models',
      'prewarm.particles',
      'prewarm.effects',
      'prewarm.fog',
      'scene',
      'firstDelivery',
      'warmFrames',
    ]);
    // У стадий-событий таймаута нет по построению (BOOT-4), у работы — есть.
    const byName = new Map(plan.document.stages.map((stage) => [stage.name, stage]));
    expect(byName.get('handshake')!.timeoutMs).toBeNull();
    expect(byName.get('firstDelivery')!.timeoutMs).toBeNull();
    expect(byName.get('prewarm.models')!.timeoutMs).toBeGreaterThan(0);
  });
});
