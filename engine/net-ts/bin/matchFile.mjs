/**
 * Общее для обоих запускалок: хук резолва и чтение файла матча.
 *
 * Шага сборки нет по той же причине, что у `core-ts/bin/sim.mjs`: типы Node
 * стрипает сам (>=22.18), а хук добавляет единственное, чего ему не хватает, —
 * исходники импортируют './x.js', и это './x.ts'.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Настоящего .ts нет — резолвим как просили.
      }
    }
    return next(specifier, context);
  },
});

/**
 * Файл матча описывает и данные матча, и контент-пак, которым его поднимать.
 * В бою эти две вещи разъезжаются: контент-пак у клиента свой, а данные матча
 * приезжают в `Welcome` (NTR-5). Здесь они в одном файле только потому, что
 * локальный прогон поднимает обе стороны с одной машины.
 */
export function readMatchFile(path) {
  const file = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(file);
  const scenes = {};
  for (const [ref, scenePath] of Object.entries(raw.contentPack ?? {})) {
    scenes[ref] = JSON.parse(readFileSync(resolve(base, scenePath), 'utf8'));
  }
  return { ...raw, scenes };
}

export function flag(name) {
  return process.argv.includes(`--${name}`);
}

export function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
