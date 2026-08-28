/**
 * Общие тестовые примитивы модуля ассетов: реализации AssetSource — обе
 * headless (ASSET-5), файловая система для эталонных фикстур и память для
 * контролируемых сценариев состояний, — и общая проверка находок валидации.
 */

import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetService, AssetSource, AssetState, Handle } from '../src/index.js';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Источник из файловой системы; заодно считает чтения для проверки кэша. */
export class FsAssetSource implements AssetSource {
  readonly reads: string[] = [];

  constructor(private readonly root: string) {}

  async read(id: string): Promise<ArrayBuffer> {
    this.reads.push(id);
    const buf = await readFile(join(this.root, id));
    const out = new ArrayBuffer(buf.byteLength);
    new Uint8Array(out).set(buf);
    return out;
  }
}

type MemoryFile = ArrayBuffer | (() => Promise<ArrayBuffer>);

/** Источник из памяти: значение — байты или функция (для отложенных/падающих чтений). */
export class MemoryAssetSource implements AssetSource {
  readonly reads: string[] = [];

  constructor(private readonly files: Map<string, MemoryFile>) {}

  async read(id: string): Promise<ArrayBuffer> {
    this.reads.push(id);
    const file = this.files.get(id);
    if (file == null) throw new Error(`файл "${id}" недоступен`);
    return typeof file === 'function' ? file() : file;
  }
}

/** Дождаться выхода из `loading` (готовности или сбоя) опросом состояния. */
export async function settled<T>(svc: AssetService, handle: Handle<T>): Promise<AssetState<T>> {
  for (let i = 0; i < 1000; i++) {
    const s = svc.state(handle);
    if (s.status !== 'loading') return s;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`ассет "${handle.id}" не вышел из loading`);
}

export function bytesOf(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  const out = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(out).set(encoded);
  return out;
}

/**
 * Результат валидации глазами теста: провал несёт свои находки, успех не несёт
 * ничего, что проверке нужно. Форма общая у всех валидаторов модуля —
 * манифеста, парного документа, эмиттерного ассета, карты кривизны и LUT.
 */
export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Провал валидации, в находках которого нашлась каждая из ожидаемых. Один
 * помощник на все документы модуля: разошедшиеся тексты проваленной проверки
 * читались бы как разные проверки, хотя проверка одна.
 */
export function expectValidationErrors(
  result: ValidationResult,
  patterns: readonly RegExp[],
): readonly string[] {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('ожидался провал валидации');
  const { errors } = result;
  for (const pattern of patterns) {
    expect(
      errors.some((message) => pattern.test(message)),
      `нет ошибки под ${String(pattern)}; есть:\n${errors.join('\n')}`,
    ).toBe(true);
  }
  return errors;
}
