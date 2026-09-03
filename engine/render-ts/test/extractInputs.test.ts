/**
 * Вход потока тиков: что именно воркер кладёт в плоскую форму и чего он при
 * этом НЕ делает (change `fog-observer-inputs`, `rendering` REND-26).
 *
 * Две темы, обе — про границу владений, а не про алгоритм:
 *
 * - уровень сущности едет ДВУМЯ колонками: уровень клетки под ней (картинке —
 *   посадка, наклон, дуга: REND-7, REND-10, REND-12) и уровень, которым её
 *   видит симуляция (маске тумана — срез и тени: FOW-9, PHYS-13). У прыгающего
 *   и летящего это разные величины (LOC-5, LOC-6, TERR-4);
 * - путь извлечения не аллоцирует пропорционально сцене: ни массива живых, ни
 *   результата выборки размером в мир, ни точки на сущность, ни строкового
 *   ключа на величину (REND-26).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOT_COMPONENT,
  FIXED_ONE,
  LEVEL_OVERRIDE_COMPONENT,
  fixed,
  initialState,
  loadScene,
  mathApi,
  tick,
  worldInitSpawn,
  type Scene,
  type Simulation,
} from '@fluxus/core';
import { Extractor, kindByTags } from '../src/index.js';

const F = (n: number): number => fixed.fromFloat(n);
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Стенд: 2×2 клетки, правый столбец — уровень 1. Прыгун стоит НАД клеткой
 * уровня 1, а `LevelOverride` держит его на уровне взлёта (LOC-5).
 */
function makeStand(): { scene: Scene; sim: Simulation } {
  const scene = loadScene({
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
      { name: 'Health', fields: { hp: 'i32' } },
    ],
    prefabs: [
      { name: 'Runner', components: { Position: {}, Health: { hp: 10 } }, tags: ['Runner'] },
      {
        name: 'Jumper',
        components: { Position: {}, [LEVEL_OVERRIDE_COMPONENT]: { level: 0 }, Health: { hp: 10 } },
        tags: ['Runner'],
      },
    ],
    terrain: {
      width: 2,
      height: 2,
      tileSize: FIXED_ONE,
      levels: ['01', '01'],
      flags: ['..', '..'],
    },
  });
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };
  return { scene, sim };
}

function makeExtractor(scene: Scene): Extractor {
  return new Extractor({
    kindOf: kindByTags(['Runner']),
    terrainGrid: scene.terrain!.grid,
    stats: [{ name: 'hp', component: 'Health', field: 'hp' }],
  });
}

describe('F-1: уровень клетки и уровень симуляции — две колонки (TERR-4, FOW-9)', () => {
  it('прыгун над клеткой уровня 1 едет с уровнем клетки 1 и уровнем симуляции 0', () => {
    const { scene, sim } = makeStand();
    // Обе сущности — над правым столбцом (уровень клетки 1); у прыгуна стоит
    // override уровня взлёта, у бегуна его нет вовсе.
    worldInitSpawn(scene.world, 'Runner', { Position: { x: F(1.5), y: F(0.5) } });
    worldInitSpawn(scene.world, 'Jumper', {
      Position: { x: F(1.5), y: F(1.5) },
      [LEVEL_OVERRIDE_COMPONENT]: { level: 0 },
    });
    const state = initialState(scene.world, 7);
    const ext = makeExtractor(scene).extract(tick(sim, state));

    expect(ext.count).toBe(2);
    // Бегун: override нет — обе колонки говорят одно и то же.
    expect(ext.level[0]).toBe(1);
    expect(ext.simLevel[0]).toBe(1);
    // Прыгун: картинке — уровень клетки ПОД ним, симуляции — уровень взлёта.
    // Кормить маску тумана первым значило бы открыть верхний ярус на те тики,
    // на которые симуляция держит наблюдателя внизу (FOW-9).
    expect(ext.level[1]).toBe(1);
    expect(ext.simLevel[1]).toBe(0);
  });

  it('без сетки террейна обе колонки — ноль, а не расхождение', () => {
    const scene = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [{ name: 'Runner', components: { Position: {} }, tags: ['Runner'] }],
    });
    worldInitSpawn(scene.world, 'Runner', { Position: { x: F(1.5), y: F(0.5) } });
    const sim: Simulation = { systems: scene.systems, worldSeed: 7, math: mathApi };
    const state = initialState(scene.world, 7);
    const extractor = new Extractor({ kindOf: kindByTags(['Runner']) });
    const ext = extractor.extract(tick(sim, state));
    expect(ext.level[0]).toBe(0);
    expect(ext.simLevel[0]).toBe(0);
  });
});

describe('REND-26: путь извлечения не аллоцирует пропорционально сцене', () => {
  it('колонки устоявшегося мира — ТЕ ЖЕ объекты между извлечениями', () => {
    const { scene, sim } = makeStand();
    for (const x of [0.5, 1.5]) {
      worldInitSpawn(scene.world, 'Runner', { Position: { x: F(x), y: F(0.5) } });
    }
    const state = initialState(scene.world, 7);
    const extractor = makeExtractor(scene);
    const first = extractor.extract(tick(sim, state));
    const columns = {
      id: first.id,
      x: first.x,
      level: first.level,
      simLevel: first.simLevel,
      statValue: first.statValue,
    };
    for (let step = 0; step < 8; step++) {
      const next = extractor.extract(tick(sim, state));
      expect(next.id).toBe(columns.id);
      expect(next.x).toBe(columns.x);
      expect(next.level).toBe(columns.level);
      expect(next.simLevel).toBe(columns.simLevel);
      expect(next.statValue).toBe(columns.statValue);
    }
  });

  /**
   * Структурный страж по образцу CLI-8: инварианты, которые тест наблюдаемым
   * поведением не ловит, держит проверка исходника — с файлом, строкой и
   * названной причиной. Каждый запрет здесь — находка аудита §2.1 (P-2, P-3):
   * контейнер размером в мир, объект на сущность, строка на величину.
   */
  it('в пути извлечения нет вызовов, аллоцирующих размером в мир или на сущность', () => {
    const forbidden: readonly { pattern: RegExp; reason: string }[] = [
      {
        pattern: /world\.listAlive\(/,
        reason: 'массив живых сущностей размером в мир на каждое извлечение (P-2)',
      },
      {
        pattern: /(?<![A-Za-z])query\(/,
        reason: 'результат выборки размером в мир на каждое извлечение (P-2)',
      },
      {
        pattern: /cellAt\((?!XY)/,
        reason: 'Vec2 на сущность на тик: клетка спрашивается раздёрнутыми координатами (P-3)',
      },
    ];
    const violations: string[] = [];
    for (const file of ['extractor.ts', 'statSources.ts']) {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Комментарии называют запрещённое по имени — они и объясняют запрет.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const rule of forbidden) {
          if (rule.pattern.test(code)) {
            violations.push(`${file}:${index + 1}: ${rule.reason} — ${line.trim()}`);
          }
        }
      });
    }
    expect(violations.join('\n')).toBe('');
  });

  it('масштаб стата берётся по индексу записи, а не по строковому ключу (P-3)', () => {
    // Величина `fixed` обязана приехать в мировых единицах (REND-1), и ключ
    // `компонент.поле` на каждую пару «сущность × запись» был бы строкой на
    // величину каждый тик.
    const scene = loadScene({
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: 'Vision', fields: { radius: 'fixed' } },
        { name: 'Health', fields: { hp: 'i32' } },
      ],
      prefabs: [
        {
          name: 'Runner',
          components: { Position: {}, Vision: { radius: F(3) }, Health: { hp: 7 } },
          tags: ['Runner'],
        },
      ],
    });
    worldInitSpawn(scene.world, 'Runner', { Position: { x: F(1), y: F(1) } });
    const sim: Simulation = { systems: scene.systems, worldSeed: 7, math: mathApi };
    const state = initialState(scene.world, 7);
    const extractor = new Extractor({
      kindOf: kindByTags(['Runner']),
      stats: [
        { name: 'hp', component: 'Health', field: 'hp' },
        { name: 'vision', component: 'Vision', field: 'radius' },
      ],
    });
    const ext = extractor.extract(tick(sim, state));
    expect(ext.statPairs).toBe(2);
    expect(ext.statValue[0]).toBe(7);
    expect(ext.statValue[1]).toBeCloseTo(3, 9);
    // Второй проход берёт кэш масштабов: величины те же, а не «раз в первый».
    const again = extractor.extract(tick(sim, state));
    expect(again.statValue[1]).toBeCloseTo(3, 9);
  });
});

describe('P-3: индекс слотов способностей переиспользуется и ОЧИЩАЕТСЯ (ABIL-1)', () => {
  /**
   * Внутренние словари «номер слота → сущность» возвращаются в запас вместо
   * пересоздания — иначе кадр заводит словарь на каждого владельца слотов
   * (REND-26). Риск переиспользования один: недочищенный словарь оставил бы
   * стат от исчезнувшего слота, и виджет показал бы «данные» там, где их нет
   * (HUD-8 — «нет данных» и «ноль» обязаны различаться).
   */
  it('слот исчез — стат владельца исчезает вместе с ним, а не черствеет', () => {
    const scene = loadScene({
      components: [
        { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
        { name: ABILITY_SLOT_COMPONENT, fields: { owner: 'entity', slotIndex: 'i32' } },
        { name: 'AbilityCooldown', fields: { remaining: 'i32' } },
      ],
      prefabs: [
        { name: 'Hero', components: { Position: {} }, tags: ['Runner'] },
        {
          name: 'Slot',
          components: {
            [ABILITY_SLOT_COMPONENT]: { owner: 0, slotIndex: 0 },
            AbilityCooldown: { remaining: 0 },
          },
        },
      ],
    });
    const hero = worldInitSpawn(scene.world, 'Hero', { Position: { x: F(1), y: F(1) } });
    worldInitSpawn(scene.world, 'Slot', {
      [ABILITY_SLOT_COMPONENT]: { owner: hero, slotIndex: 0 },
      AbilityCooldown: { remaining: 12 },
    });
    const sim: Simulation = { systems: scene.systems, worldSeed: 7, math: mathApi };
    const state = initialState(scene.world, 7);
    const extractor = new Extractor({
      kindOf: kindByTags(['Runner']),
      stats: [{ name: 'cd', component: 'AbilityCooldown', field: 'remaining', slotIndex: 0 }],
    });

    // Первый кадр: стат слотовой формы едет НА ВЛАДЕЛЬЦЕ (у слота нет Position).
    const first = extractor.extract(tick(sim, state));
    expect(first.count).toBe(1);
    expect(first.statCount[0]).toBe(1);
    expect(first.statValue[0]).toBe(12);

    // Второй кадр по тому же миру: индекс перестроен в переиспользованном
    // словаре — величина та же, а не удвоенная и не потерянная.
    const second = extractor.extract(tick(sim, state));
    expect(second.statCount[0]).toBe(1);
    expect(second.statValue[0]).toBe(12);
  });
});

describe('P-4: кэши экстрактора живут ровно одну ветвь истории (NTR-16)', () => {
  /**
   * Вид сущности и направление её каста кэшируются ПО ID — за поколенческим
   * идентификатором это безопасно ровно до смены ветви: перемотка откатывает
   * счётчик поколений, и тот же упакованный id достаётся другой сущности.
   * Унаследованный вид держался бы до её смерти, включая `−1` («не рисуется»).
   *
   * Стенд подставляет экстрактору два мира, в которых один и тот же id
   * принадлежит разным сущностям, — ровно то, что он видит за разрывом ветви.
   */
  function worldOf(prefab: string): { result: () => ReturnType<typeof tick>; sim: Simulation } {
    const scene = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [
        { name: 'Runner', components: { Position: {} }, tags: ['Runner'] },
        { name: 'Boss', components: { Position: {} }, tags: ['Boss'] },
      ],
    });
    worldInitSpawn(scene.world, prefab, { Position: { x: F(1), y: F(1) } });
    const sim: Simulation = { systems: scene.systems, worldSeed: 7, math: mathApi };
    const state = initialState(scene.world, 7);
    return { result: () => tick(sim, state), sim };
  }

  it('смена ветви перечитывает вид сущности, а не наследует чужой', () => {
    const before = worldOf('Runner');
    const after = worldOf('Boss');
    const extractor = new Extractor({ kindOf: kindByTags(['Runner', 'Boss']) });

    const first = extractor.extract(before.result());
    expect(first.kindTable[first.kind[0]!]).toBe('Runner');

    // Реплеевый проход = смена ветви (SHELL-7): id тот же, сущность другая.
    const replayed = { ...after.result(), isReplay: true };
    const second = extractor.extract(replayed);
    expect(second.id[0]).toBe(first.id[0]);
    expect(second.kindTable[second.kind[0]!]).toBe('Boss');
  });

  it('внутри одной ветви кэш держит: вид сущности за её жизнь не меняется', () => {
    const stand = worldOf('Runner');
    const extractor = new Extractor({ kindOf: kindByTags(['Runner', 'Boss']) });
    const first = extractor.extract(stand.result());
    const second = extractor.extract(stand.result());
    expect(second.kind[0]).toBe(first.kind[0]);
    expect(second.kindTable[second.kind[0]!]).toBe('Runner');
  });
});
