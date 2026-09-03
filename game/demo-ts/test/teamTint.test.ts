/**
 * Цвет команды на инстансах (`app/teamTint.ts`, `rendering` REND-40) —
 * политика ЭТОГО приложения над механизмом рендера.
 *
 * Проверяется ровно её половина работы: доставленный стат `team` через документ
 * палитры превращается в цвет и уходит в порт «цвет на сущность»; сущность без
 * команды тинта не получает; команда, которой в палитре нет, снимает тинт, а не
 * красит чем попало; повторная подача того же цвета кадром не делается, а
 * инстанс, которого ещё нет (модель едет, ASSET-4), получает цвет следующим
 * кадром.
 *
 * Браузер не нужен: фабрика на инъекции, стенд подаёт доставку и порт сам.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { EntityView, InstanceTintInput, ModelInstanceView } from '@fluxus/render';
import { createStealthTint } from '../app/stealthTint.js';
import { createTeamTint, teamPalette, type TeamTint } from '../app/teamTint.js';
import { STATS } from '../app/sim.js';

const BLUE = 1 as EntityId;
const RED = 2 as EntityId;
const PROP = 3 as EntityId;

/** Доставленная сущность: подаче нужны только статы. */
function viewOf(stats: Record<string, number>): EntityView {
  return { stats: new Map(Object.entries(stats)) } as unknown as EntityView;
}

interface Stand {
  readonly tint: TeamTint;
  readonly entities: Map<EntityId, EntityView>;
  /** Что и кому подано портом; `null` — тинт снят. */
  readonly applied: (InstanceTintInput | null)[];
  readonly targets: EntityId[];
  /** Кому инстанса ещё нет: порт отвечает `false`, как настоящая подсистема. */
  readonly missing: Set<EntityId>;
}

function stand(): Stand {
  const entities = new Map<EntityId, EntityView>();
  const applied: (InstanceTintInput | null)[] = [];
  const targets: EntityId[] = [];
  const missing = new Set<EntityId>();
  const tint = createTeamTint({
    entities: () => entities,
    setTint: (entity, value) => {
      if (missing.has(entity)) return false;
      targets.push(entity);
      applied.push(value);
      return true;
    },
  });
  return { tint, entities, applied, targets, missing };
}

describe('цвет команды из доставленного стата (REND-40)', () => {
  it('разные команды получают разные цвета палитры', () => {
    const s = stand();
    s.entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    s.entities.set(RED, viewOf({ [STATS.team]: 1 }));
    s.tint.update();

    const palette = teamPalette();
    expect(s.targets).toEqual([BLUE, RED]);
    expect(s.applied[0]).toEqual(palette.get(0));
    expect(s.applied[1]).toEqual(palette.get(1));
    // Ради этого канал и заведён: два героя одной модели различимы в кадре.
    expect(s.applied[0]).not.toEqual(s.applied[1]);
  });

  it('сущность без стата команды тинта не получает', () => {
    const s = stand();
    s.entities.set(PROP, viewOf({}));
    s.tint.update();
    expect(s.targets).toEqual([]);
  });

  it('команда, которой в палитре нет, снимает тинт, а не красит чем попало', () => {
    const s = stand();
    s.entities.set(BLUE, viewOf({ [STATS.team]: 99 }));
    s.tint.update();
    expect(s.targets).toEqual([BLUE]);
    expect(s.applied[0]).toBeNull();
  });

  it('тот же цвет повторно не подаётся, а смена команды подаётся', () => {
    const s = stand();
    s.entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    s.tint.update();
    s.tint.update();
    expect(s.targets).toEqual([BLUE]);

    // Сущность сменила команду (смена стороны, захват): цвет едет заново.
    s.entities.set(BLUE, viewOf({ [STATS.team]: 1 }));
    s.tint.update();
    expect(s.targets).toEqual([BLUE, BLUE]);
    expect(s.applied[1]).toEqual(teamPalette().get(1));
  });

  it('инстанса ещё нет — подача повторяется следующим кадром (ASSET-4)', () => {
    const s = stand();
    s.missing.add(BLUE);
    s.entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    s.tint.update();
    expect(s.targets).toEqual([]);

    // Модель доехала, инстанс появился: цвет доезжает до него без второго
    // события — подача помнит только то, что дошло.
    s.missing.delete(BLUE);
    s.tint.update();
    expect(s.targets).toEqual([BLUE]);
  });

  it('ушедшая из доставки сущность забыта — вернувшаяся красится заново', () => {
    const s = stand();
    s.entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    s.tint.update();
    s.entities.delete(BLUE);
    s.tint.update();
    s.entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    s.tint.update();
    expect(s.targets).toEqual([BLUE, BLUE]);
  });

  it('палитра — документ приложения: цвета попарно различны', () => {
    const palette = teamPalette();
    expect(palette.size).toBeGreaterThanOrEqual(2);
    const seen = new Set<string>();
    for (const tint of palette.values()) {
      seen.add(`${tint.r},${tint.g},${tint.b}`);
      // Сила — доля: тинт множит цвет, а не подменяет модель силуэтом.
      expect(tint.strength).toBeGreaterThan(0);
      expect(tint.strength).toBeLessThanOrEqual(1);
    }
    expect(seen.size).toBe(palette.size);
  });
});

describe('цвет команды и стелс на одном инстансе (REND-40, FOW-13)', () => {
  /**
   * Две подачи главного потока пишут РАЗНЫЕ поля одних и тех же собственных
   * материалов инстанса (REND-6): цвет команды — `color` (его ставит канал
   * тинта рендера), стелс — `opacity` и `transparent`. Регрессия, ради которой
   * тест и стоит: подача, вернувшая «как было» целым материалом, стёрла бы
   * чужую работу — команда пропала бы с невидимки, вышедшего из стелса.
   */
  it('стелс возвращает непрозрачность, не трогая цвет команды', () => {
    const material = new THREE.MeshStandardMaterial();
    // Цвет команды уже стоит: его написал канал тинта рендера.
    const teamColor = new THREE.Color(0.3, 0.4, 0.9);
    material.color.copy(teamColor);
    const model = { materials: [material], ownsMaterials: true, ownTextureTargets: () => new Map() };
    const view = { model } as unknown as ModelInstanceView;

    const entities = new Map<EntityId, EntityView>();
    const stealth = createStealthTint({
      entities: () => entities,
      instanceFor: () => view,
      heroId: () => BLUE,
    });
    entities.set(BLUE, viewOf({ [STATS.team]: 0 }));
    entities.set(RED, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 1 << 2 }));

    stealth.update();
    expect(material.opacity).toBeLessThan(1);
    expect(material.color.getHex()).toBe(teamColor.getHex());

    entities.set(RED, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 0 }));
    stealth.update();
    expect(material.opacity).toBe(1);
    // Цвет команды пережил снятие стелса: подачи не наступают друг на друга.
    expect(material.color.getHex()).toBe(teamColor.getHex());
  });
});
