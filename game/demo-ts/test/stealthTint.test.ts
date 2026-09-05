/**
 * Подача стелс-состояний (`app/stealthTint.ts`, `fog-of-war` FOW-13) — картинка
 * главного потока над ДОСТАВЛЕННЫМ состоянием.
 *
 * Проверяется ровно контракт FOW-13, у которого нет второго владельца:
 *
 * — свой юнит с ненулевой свёрткой стелса (`StealthState.mask`) подан
 *   полупрозрачным — факт «под стелсом» читается из доставленного стата;
 * — чужой под НЕВСКРЫТЫМ мягким каналом — силуэтом (низкая непрозрачность);
 *   жёсткий невскрытый сюда не доедет — его вырезал фильтр снапшота (NET-12);
 * — вскрытость канала командой зрителя вычисляется из доставленной детекции
 *   союзников (OR `DetectionState.mask`): вскрытый подан обычной подачей;
 * — числа — из секции `stealth` парного документа (PRES-2), без секции —
 *   документированные умолчания; на разделяемые материалы ассета подача не
 *   опирается — сперва copy-on-write (REND-6).
 *
 * Браузер не нужен: фабрика на инъекции, стенд подаёт доставку и инстансы сам.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { EntityId } from '@fluxus/core';
import type { EntityView, ModelInstanceView } from '@fluxus/render';
import { createStealthTint, STEALTH_TINT_DEFAULTS, type StealthTint } from '../app/stealthTint.js';
import { STATS } from '../app/sim.js';

const HERO = 1 as EntityId;
const ALLY = 2 as EntityId;
const ENEMY = 3 as EntityId;

/** Доставленная сущность: подаче нужны только статы. */
function viewOf(stats: Record<string, number>): EntityView {
  return { stats: new Map(Object.entries(stats)) } as unknown as EntityView;
}

/** Инстанс с собственными материалами (copy-on-write уже случился). */
function ownedInstance(opacity = 1): {
  readonly view: ModelInstanceView;
  readonly material: THREE.MeshStandardMaterial;
} {
  const material = new THREE.MeshStandardMaterial();
  material.opacity = opacity;
  material.transparent = false;
  const model = {
    materials: [material],
    ownsMaterials: true,
    ownTextureTargets: () => new Map(),
  };
  return { view: { model } as unknown as ModelInstanceView, material };
}

interface Stand {
  readonly tint: StealthTint;
  readonly entities: Map<EntityId, EntityView>;
  readonly instances: Map<EntityId, ModelInstanceView>;
  /** Доставленный тик кадра — вход доли затухания (FOW-13). */
  readonly clock: { tick: number | undefined };
}

function stand(stealth?: { allyOpacity?: number; enemyOpacity?: number }): Stand {
  const entities = new Map<EntityId, EntityView>();
  const instances = new Map<EntityId, ModelInstanceView>();
  const clock = { tick: undefined as number | undefined };
  const tint = createStealthTint({
    entities: () => entities,
    instanceFor: (entity) => instances.get(entity) ?? null,
    heroId: () => HERO,
    tick: () => clock.tick,
    ...(stealth === undefined ? {} : { stealth }),
  });
  return { tint, entities, instances, clock };
}

describe('FOW-13: подача стелс-состояний из доставленного снапшота', () => {
  it('свой юнит под стелсом — полупрозрачность умолчания, снятие стелса возвращает подачу', () => {
    const s = stand();
    const { view, material } = ownedInstance(1);
    s.instances.set(ALLY, view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 1 << 2 }));

    s.tint.update();
    expect(material.opacity).toBeCloseTo(STEALTH_TINT_DEFAULTS.allyOpacity, 5);
    expect(material.transparent).toBe(true);

    // Стелс спал — материалы возвращены как были.
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 0 }));
    s.tint.update();
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
  });

  it('чужой невскрытый мягкий — силуэт; детекция союзника возвращает обычную подачу', () => {
    const s = stand();
    const { view, material } = ownedInstance(1);
    s.instances.set(ENEMY, view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    s.entities.set(ENEMY, viewOf({ [STATS.team]: 1, [STATS.stealthMask]: 1 << 3 }));

    s.tint.update();
    expect(material.opacity).toBeCloseTo(STEALTH_TINT_DEFAULTS.enemyOpacity, 5);

    // Детекцию канала несёт СОЮЗНИК зрителя — вскрытость собирается OR-ом
    // доставленных свёрток команды, а не одним героем (FOW-13).
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.detectionMask]: 1 << 3 }));
    s.tint.update();
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
  });

  it('числа берутся из секции stealth документа, а не из констант кода', () => {
    const s = stand({ allyOpacity: 0.4, enemyOpacity: 0.05 });
    const allyInstance = ownedInstance(0.8);
    const enemyInstance = ownedInstance(1);
    s.instances.set(ALLY, allyInstance.view);
    s.instances.set(ENEMY, enemyInstance.view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 1 }));
    s.entities.set(ENEMY, viewOf({ [STATS.team]: 1, [STATS.stealthMask]: 1 }));

    s.tint.update();
    // Доля документа умножает ИСХОДНУЮ непрозрачность материала, а не заменяет её.
    expect(allyInstance.material.opacity).toBeCloseTo(0.8 * 0.4, 5);
    expect(enemyInstance.material.opacity).toBeCloseTo(0.05, 5);
  });

  it('разделяемые материалы сперва переводятся в свои (REND-6)', () => {
    const s = stand();
    const material = new THREE.MeshStandardMaterial();
    let owned = false;
    const model = {
      materials: [material],
      ownsMaterials: false,
      ownTextureTargets: () => {
        owned = true;
        return new Map();
      },
    };
    s.instances.set(ALLY, { model } as unknown as ModelInstanceView);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 1 }));

    s.tint.update();
    expect(owned).toBe(true);
  });

  it('сущность ушла из доставки — запись снята; батчевый ярус подачи не получает', () => {
    const s = stand();
    const { view, material } = ownedInstance(1);
    s.instances.set(ALLY, view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.stealthMask]: 1 }));
    s.tint.update();
    expect(material.transparent).toBe(true);

    // Ушла в туман: восстановление — по её же инстансу этого кадра.
    s.entities.delete(ALLY);
    s.tint.update();
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);

    // Сущность без детальной модели (батч/заглушка) просто не тонируется.
    s.entities.set(ENEMY, viewOf({ [STATS.team]: 1, [STATS.stealthMask]: 1 }));
    expect(() => { s.tint.update(); }).not.toThrow();
  });

  it('затухание ведёт доставка: доля — от доставленного тика, цель — вид, который встанет (FOW-13)', () => {
    const s = stand();
    const ally = ownedInstance(1);
    const enemy = ownedInstance(1);
    s.instances.set(ALLY, ally.view);
    s.instances.set(ENEMY, enemy.view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0 }));
    // Канала ещё нет (маска 0), но затухание идёт: тик начала 100, длительность 60.
    s.entities.set(ALLY, viewOf({ [STATS.team]: 0, [STATS.cloakStart]: 100, [STATS.cloakTicks]: 60 }));
    s.entities.set(ENEMY, viewOf({ [STATS.team]: 1, [STATS.cloakStart]: 100, [STATS.cloakTicks]: 60 }));

    // Середина фазы: половина пути от единицы к непрозрачности своего вида.
    s.clock.tick = 130;
    s.tint.update();
    expect(ally.material.opacity).toBeCloseTo(1 + (STEALTH_TINT_DEFAULTS.allyOpacity - 1) * 0.5, 5);
    // Чужой без детекции у команды зрителя — к силуэту.
    expect(enemy.material.opacity).toBeCloseTo(1 + (STEALTH_TINT_DEFAULTS.enemyOpacity - 1) * 0.5, 5);

    // Конец фазы — значение вида целиком, хотя маска ещё не доставлена.
    s.clock.tick = 160;
    s.tint.update();
    expect(ally.material.opacity).toBeCloseTo(STEALTH_TINT_DEFAULTS.allyOpacity, 5);

    // Перемотка на тик до каста — обычная подача, без остаточного перехода.
    s.clock.tick = 90;
    s.tint.update();
    expect(ally.material.opacity).toBe(1);
    expect(ally.material.transparent).toBe(false);
    expect(enemy.material.opacity).toBe(1);
  });

  it('без доставленного тика затухание не ведётся, а детекция команды ведёт чужого к обычной подаче', () => {
    const s = stand();
    const enemy = ownedInstance(1);
    s.instances.set(ENEMY, enemy.view);
    s.entities.set(HERO, viewOf({ [STATS.team]: 0, [STATS.detectionMask]: 1 }));
    s.entities.set(ENEMY, viewOf({ [STATS.team]: 1, [STATS.cloakStart]: 100, [STATS.cloakTicks]: 60 }));
    s.tint.update();
    expect(enemy.material.opacity).toBe(1);
    // У команды зрителя есть детекция: какой канал взведётся, зритель не знает,
    // и чужой остаётся в обычной подаче до прихода маски.
    s.clock.tick = 130;
    s.tint.update();
    expect(enemy.material.opacity).toBe(1);
  });
});
