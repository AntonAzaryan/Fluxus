/**
 * Общее для запускалок: хук резолва (`tsHook.mjs`, импортируется ради его
 * побочного действия) и чтение файла матча.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import './tsHook.mjs';

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
