/**
 * Форматы наружу (SER-1..3, SER-6). Единая plain-форма строится один раз, и из
 * неё одинаково идут JSON сегодня и MessagePack на этапе 14 — сам сериализатор
 * ничего не знает ни о мире, ни о порядке ключей.
 *
 * Порядок ключей задаётся при построении plain-формы (SER-6), а не здесь:
 * иначе каждая новая реализация `Serializer` обязана была бы его повторить.
 */
import { fromPlain, toPlain, type PlainWorld } from './ecs/world.js';
import type { PrefabDef } from './ecs/world.js';
import type { ComponentSchema, Snapshot } from './types.js';

export interface Serializer {
  readonly name: string;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
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
}

export function snapshotToPlain(snapshot: Snapshot): PlainSnapshot {
  return {
    tick: snapshot.tick,
    world: toPlain(snapshot.world),
    rng: [...snapshot.rng]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((stream) => ({ name: stream.name, state: Array.from(stream.state) })),
  };
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
  };
}
