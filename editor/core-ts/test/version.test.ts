/**
 * Версия каталога (ED-30) — это версия пакета: константа и манифест обязаны
 * совпадать, иначе потребитель каталога получит номер, которого нет ни в
 * одной сборке.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITOR_VERSION } from '../src/index.js';

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

describe('EDITOR_VERSION', () => {
  it('совпадает с версией пакета', () => {
    expect(EDITOR_VERSION).toBe(manifest.version);
  });

  it('принадлежит пакету editor-core', () => {
    expect(manifest.name).toBe('@game-mvp/editor-core');
  });
});
