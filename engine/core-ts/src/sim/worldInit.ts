/**
 * Хеш `worldInit` (DET-1): диагностика расхождения начальных данных до матча,
 * а не после — необъяснимый десинк на середине именно этим и объясняется.
 *
 * Считается от распакованного канонического представления, а не от байтов
 * ассета: переформатированный JSON террейна обязан давать тот же хеш. Отсюда
 * два следствия, определивших состав. Первое — карты террейна входят
 * декодированными, по клетке на элемент, а не строками алфавита. Второе —
 * представление собирается вручную, а не берётся готовым снапшотом тика 0:
 * иммутабельная часть террейна в снапшот не входит по TERR-6, а центр арены —
 * по ARENA-1 (в компоненте живёт только радиус), то есть хеш от снапшота
 * промахнулся бы мимо карты уровней и центра — мимо того, ради чего заводится.
 *
 * Чего здесь нет и почему: состояния RNG (выводится из seed по RNG-7, то есть
 * принадлежит второму члену тройки DET-1), шины событий и номера тика (пусты
 * по построению до первого `tick()`), геометрии обрывов (производная от карт,
 * расхождение в ней — дефект кода, а не данных) и конфига сцены — систем,
 * prefabs, состава компонентов (приезжает с контент-паком, его тождественность
 * обеспечивает единая версия игры, NET-16).
 */
import { toPlain } from '../ecs/world.js';
import { fnv1a32, utf8Bytes } from '../math/rng.js';
import type { ArenaApi, TerrainApi, WorldMode, WorldState } from '../types.js';

export interface WorldInitParts {
  /** Мир после начальной расстановки и до первого `tick()`. */
  readonly world: WorldState;
  /** Стартовое значение машины состояний мира (WSM-1). */
  readonly mode: WorldMode;
  /** Есть, если сцена содержит террейн: иммутабельная часть в снапшот не входит (TERR-6). */
  readonly terrain?: TerrainApi;
  /** Есть, если сцена содержит арену: центр в компонент не кладётся (ARENA-1). */
  readonly arena?: ArenaApi;
}

/**
 * Каноническое представление (DET-1). Отдельно от хеша, потому что при
 * расхождении хешей сравнивают именно его — иначе диагностика упирается в
 * восемь шестнадцатеричных цифр, которые ни на что не указывают.
 */
export function worldInitForm(parts: WorldInitParts): Record<string, unknown> {
  const form: Record<string, unknown> = {
    world: toPlain(parts.world),
    mode: parts.mode,
  };
  if (parts.terrain !== undefined) {
    const { width, height, tileSize, levels, ramps, floor } = parts.terrain.grid;
    // Массивы разворачиваются в обычные: типизированный массив сериализуется
    // объектом с числовыми ключами, то есть дал бы другой поток байт.
    form.terrain = {
      width,
      height,
      tileSize,
      levels: Array.from(levels),
      ramps: Array.from(ramps),
      floor: Array.from(floor),
    };
  }
  if (parts.arena !== undefined) {
    // Стартовый радиус отдельно не пишется: он в `ArenaBounds` и уже вошёл
    // через `world` — сценарий ARENA-1 закрыт обоими путями сразу.
    form.arena = { center: { x: parts.arena.center.x, y: parts.arena.center.y } };
  }
  return form;
}

/** Восемь строчных hex-цифр (DET-1): фиксированная ширина без знака — чтобы порт на языке со знаковым i32 не напечатал отрицательное. */
export function worldInitHash(parts: WorldInitParts): string {
  const hash = fnv1a32(utf8Bytes(canonicalJson(worldInitForm(parts))));
  return hash.toString(16).padStart(8, '0');
}

/**
 * JSON без незначащих пробелов, ключи каждого уровня отсортированы (SER-6).
 * Сортировка делается здесь, а не полагается на порядок вставки: плоская форма
 * мира строится отсортированной, но норма DET-1 говорит про поток байт, и
 * зависеть от чужого порядка вставки он не должен.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  // Все значения ядра целые: Q16.16 хранится как i32 (FP-1), поэтому вопроса
  // дробной записи не возникает.
  return JSON.stringify(value) ?? 'null';
}
