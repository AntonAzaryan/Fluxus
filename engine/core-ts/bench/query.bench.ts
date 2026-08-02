/**
 * Замер, от которого зависит решение по архетипному индексу (ECS-1, QUERY-2).
 * Вопрос: сколько стоит линейный скан живых сущностей с битовой маской, и
 * окупится ли `Map<mask, EntityId[]>`, который придётся глубоко копировать при
 * каждом снятии снапшота.
 *
 * Запуск: npx tsx bench/query.bench.ts
 */
import { createWorld, spawn, type PrefabDef } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { initialState, takeSnapshot } from '../src/tick.js';
import type { ComponentSchema } from '../src/types.js';

const ENTITIES = 5000;
const RARE_SHARE = 0.01;
const TICK_BUDGET_NS = 16_666_666;

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Health', fields: { hp: 'i32', max: 'i32' } },
  { name: 'Rare', fields: { v: 'i32' } },
];

const PREFABS: PrefabDef[] = [
  {
    name: 'common',
    components: { Position: { x: 0, y: 0 }, Velocity: { x: 1, y: 0 }, Health: { hp: 100, max: 100 } },
  },
  {
    name: 'rare',
    components: { Position: { x: 0, y: 0 }, Velocity: { x: 1, y: 0 }, Health: { hp: 100, max: 100 }, Rare: { v: 1 } },
  },
];

const state = initialState(createWorld(SCHEMAS, PREFABS, ENTITIES + 16), 1);
for (let i = 0; i < ENTITIES; i++) {
  spawn(state.world, i < ENTITIES * RARE_SHARE ? 'rare' : 'common');
}

function bench(label: string, fn: () => void, iterations: number): void {
  for (let i = 0; i < 20; i++) fn(); // прогрев JIT
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const ns = Number(process.hrtime.bigint() - start) / iterations;
  console.log(
    `${label.padEnd(44)} ${(ns / 1000).toFixed(1).padStart(8)} мкс   ` +
      `${((ns / TICK_BUDGET_NS) * 100).toFixed(2)}% тика`,
  );
}

console.log(`\nсущностей: ${ENTITIES}, бюджет тика при 60 Гц: 16666 мкс\n`);

// 100% совпадений — худший случай для скана; архетипный индекс тут не выиграет.
bench('query all:[Position] — 100% совпадений', () => void query(state.world, { all: ['Position'] }), 500);

// ~1% совпадений — профиль, ради которого архетипный индекс и заводят.
bench('query all:[Rare] — 1% совпадений', () => void query(state.world, { all: ['Rare'] }), 500);

bench(
  'query all:[Position,Velocity] not:[Rare]',
  () => void query(state.world, { all: ['Position', 'Velocity'], not: ['Rare'] }),
  500,
);

// Цена, которую архетипный индекс добавил бы к каждому снятию снапшота.
bench('takeSnapshot — полная копия мира', () => void takeSnapshot(state), 100);

console.log(
  '\nЧитать так: 20 систем × стоимость query = расход на тик.\n' +
    'Снапшот при интервале 30 тиков (SNAP-4) размазывается на 30 тиков.\n',
);
