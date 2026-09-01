/**
 * Транзиентные эффекты в кадре вьюпорта (`rendering` REND-23, REND-17, ED-1).
 *
 * Вьюпорт редактора обязан показывать автору ТО ЖЕ изображение, что видит
 * игрок (ED-1, REND-11: «Изображение документного режима расходиться с игровым
 * MUST NOT»), а переподачу манифеста обязан получать КАЖДЫЙ его читатель
 * (REND-17). Подсистема эффектов — и то, и другое: без неё вид, изображение
 * которого отдано записи `effects.byKind`, не рисует никто — заглушки моделей у
 * него нет намеренно (REND-37), — и снаряд в превью (ED-9) просто невидим.
 *
 * Продюсер здесь документный, а не поток тиков превью, и это законно: подсистемы
 * продюсеров не различают (REND-11), а обе половины — и набор инстансов, и
 * прогон ED-9 — публикуют в ОДНУ presentation-сцену вьюпорта. Проверяется
 * поэтому набор подсистем, а не путь доставки: расхождение кадра автора с кадром
 * игрока начинается с подсистемы, которой в наборе нет.
 *
 * Собрать вьюпорт целиком headless нечем (`canRender`: WebGL), но его НАБОР —
 * можно: его поднимает та же `registerViewportSubsystems`, которой пользуется
 * `createSceneStage`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTerrainGrid, type TerrainGrid } from '@fluxus/core';
import type { AssetService, VisualManifest } from '@fluxus/assets';
import { DocumentSource, PresentationStage, type RenderContext } from '@fluxus/render';
import { registerViewportSubsystems, type ViewportSubsystems } from '../src/areas/sceneStage.js';

const SIZE = 4;

function flatGrid(): TerrainGrid {
  return createTerrainGrid({
    width: SIZE,
    height: SIZE,
    tileSize: 65536,
    levels: Array.from({ length: SIZE }, () => '0'.repeat(SIZE)),
    flags: Array.from({ length: SIZE }, () => '.'.repeat(SIZE)),
  });
}

/**
 * Манифест дуэльной арены в миниатюре: у вида `Fireball` модельной записи нет
 * вовсе, а изображение ему даёт запись секции транзиентных эффектов — ровно та
 * конфигурация, на которой пропуск подсистемы и виден (REND-37).
 */
function manifest(color = '#ff8a3c'): VisualManifest {
  return {
    entities: {},
    effects: {
      byKind: {
        Fireball: { primitive: 'sphere', color, radius: 0.15, alpha: 0.8, height: 0.3 },
      },
    },
  };
}

/** Пустая секция эффектов: запись вида исчезла — исчезнуть должна и оболочка. */
function manifestWithoutFireball(): VisualManifest {
  return { entities: {}, effects: { byKind: {} } };
}

interface Rig {
  readonly parts: ViewportSubsystems;
  readonly source: DocumentSource;
}

/** Набор подсистем вьюпорта и его документный продюсер — без единого WebGL. */
function rig(options: { grid?: TerrainGrid | null; visuals?: VisualManifest } = {}): Rig {
  const context: RenderContext = {
    scene: new THREE.Scene(),
    assets: {} as unknown as AssetService,
    config: { heightStep: 0.6 },
  };
  const stage = new PresentationStage(context);
  const parts = registerViewportSubsystems(stage, {
    grid: options.grid === undefined ? flatGrid() : options.grid,
    camera: new THREE.PerspectiveCamera(),
    visuals: options.visuals ?? manifest(),
  });
  return { parts, source: new DocumentSource(stage, { clock: () => 0 }) };
}

describe('вьюпорт рисует транзиентные эффекты (REND-23, REND-11, ED-1)', () => {
  it('вид, изображение которого — запись effects.byKind, в кадре есть', () => {
    const { parts, source } = rig();

    source.apply([{ key: 'fireball', kind: 'Fireball', x: 1, y: 1 }]);

    expect(parts.effects.activeCount).toBe(1);
    // И заглушки моделей над ним нет: запись в документе есть, просто не та, по
    // которой строит инстансы подсистема моделей (REND-37). Без подсистемы
    // эффектов это и означало бы «не рисует никто».
    const entity = source.entityOf('fireball')!;
    expect(parts.models.instanceFor(entity)?.placeholder).toBe(false);
  });

  it('исчез размещённый — исчезла оболочка (REND-23)', () => {
    const { parts, source } = rig();
    source.apply([{ key: 'fireball', kind: 'Fireball', x: 1, y: 1 }]);

    source.apply([]);

    expect(parts.effects.activeCount).toBe(0);
  });

  it('кадр без террейна (ED-20) поднимает ту же подсистему', () => {
    const { parts, source } = rig({ grid: null });

    source.apply([{ key: 'fireball', kind: 'Fireball', x: 0, y: 0, level: 0 }]);

    // Вырожденный случай — не вторая сборка рендера (ED-1): у него нет только
    // того, что выведено из сетки, а подсистема эффектов из неё не выводится.
    expect(parts.surface).toBeNull();
    expect(parts.effects.activeCount).toBe(1);
  });
});

describe('переподача манифеста доходит до каждого читателя (REND-17)', () => {
  it('правленая запись эффекта действует на живой оболочке', () => {
    const { parts, source } = rig();
    source.apply([{ key: 'fireball', kind: 'Fireball', x: 1, y: 1 }]);

    parts.applyManifest(manifest('#20d0ff'));

    expect(parts.effects.activeCount).toBe(1);
    expect(parts.effects.effectFor(source.entityOf('fireball')!)?.record.color).toBe('#20d0ff');
  });

  it('исчезнувшая запись снимает оболочку, и заглушки на её месте не появляется', () => {
    const { parts, source } = rig();
    source.apply([{ key: 'fireball', kind: 'Fireball', x: 1, y: 1 }]);

    parts.applyManifest(manifestWithoutFireball());

    expect(parts.effects.activeCount).toBe(0);
    // Заявки не стало — заглушка ASSET-6/REND-37 возвращается: вид, о котором
    // манифест не говорит ничего, автор обязан увидеть недостачей, а не пустотой.
    expect(parts.models.instanceFor(source.entityOf('fireball')!)?.placeholder).toBe(true);
  });
});
