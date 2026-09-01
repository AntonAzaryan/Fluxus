/**
 * Форматы наружу (SER-1..3, SER-6). Единая plain-форма строится один раз, и из
 * неё одинаково идут JSON документов и эталонов и MessagePack кадра на проводе
 * (SER-3) — сам сериализатор ничего не знает ни о мире, ни о порядке ключей.
 *
 * Порядок ключей задаётся при построении plain-формы (SER-6), а не здесь:
 * иначе каждая новая реализация `Serializer` обязана была бы его повторить.
 */
import { fromPlain, toPlain, type PlainWorld } from '../ecs/world.js';
import type { PrefabDef } from '../ecs/world.js';
import type { ComponentSchema, GameEvent, Snapshot, WorldMode } from '../types.js';

/**
 * `encode`/`decode` объявлены полями-функциями, а не методами. Разница не
 * косметическая: метод можно оторвать от объекта и получить `this`, которого
 * нет, — а сериализатор ровно так и передают (`prettyJsonSerializer` берёт
 * `decode` у JSON-варианта). Поле-функция объявляет, что `this` не нужен, и
 * заодно проверяется контравариантно, а не бивариантно.
 */
export interface Serializer {
  readonly name: string;
  readonly encode: (value: unknown) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Байты, а не строка, даже для JSON: иначе появление бинарного формата
 * потребовало бы менять сигнатуру — ровно то, от чего SER-2 защищает.
 */
export const jsonSerializer: Serializer = {
  name: 'json',
  encode: (value) => encoder.encode(JSON.stringify(value)),
  decode: (bytes) => JSON.parse(decoder.decode(bytes)) as unknown,
};

/** Читаемый вариант того же формата — для golden-файлов и глаз. */
export const prettyJsonSerializer: Serializer = {
  name: 'json-pretty',
  encode: (value) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`),
  decode: jsonSerializer.decode,
};

export interface PlainSnapshot {
  readonly tick: number;
  readonly world: PlainWorld;
  /** Стримы отсортированы по имени (SER-6). */
  readonly rng: readonly { readonly name: string; readonly state: readonly number[] }[];
  /** Шина тика: часть состояния, а не побочный вывод (SNAP-1, REW-10). */
  readonly events: readonly {
    readonly type: string;
    readonly data: Readonly<Record<string, number>>;
  }[];
  /** Машина состояний мира входит в снапшот (SNAP-1, WSM-1). */
  readonly mode: WorldMode;
}

export function snapshotToPlain(snapshot: Snapshot): PlainSnapshot {
  return {
    tick: snapshot.tick,
    world: toPlain(snapshot.world),
    rng: [...snapshot.rng]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((stream) => ({ name: stream.name, state: Array.from(stream.state) })),
    events: snapshot.events.map((event) => ({ type: event.type, data: sortKeys(event.data) })),
    mode: snapshot.mode,
  };
}

/** Порядок ключей задаётся здесь, при построении plain-формы, а не сериализатором (SER-6). */
function sortKeys(data: Readonly<Record<string, number>>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(data).sort()) sorted[key] = data[key]!;
  return sorted;
}

export function snapshotFromPlain(
  plain: PlainSnapshot,
  schemas: readonly ComponentSchema[],
  prefabs: readonly PrefabDef[] = [],
): Snapshot {
  return {
    tick: plain.tick,
    world: fromPlain(plain.world, schemas, prefabs),
    rng: plain.rng.map((stream) => ({ name: stream.name, state: Uint32Array.from(stream.state) })),
    events: plain.events.map((event): GameEvent => ({ type: event.type, data: event.data })),
    mode: plain.mode,
  };
}
