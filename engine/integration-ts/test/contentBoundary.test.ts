/**
 * Граница контента (CONT-1): в пакетах движка не лежит игровой контент.
 *
 * Проверка живёт в кросс-слойной сюите, потому что правило репозиторное, а не
 * про один пакет: `integration-ts` — единственное место, которому видны все
 * пакеты сразу. Сканер общий — engine/tests/guard/contentLocation.ts; здесь
 * конфигурация движка и тесты самого сканера.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENGINE_FIXTURE_EXCLUSIONS,
  formatContentViolations,
  scanContentLocation,
} from '../../tests/guard/contentLocation.js';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('guard: игровой контент вне пакетов движка (CONT-1)', () => {
  it('в engine/ нет документов контента, кроме освобождённых фикстур', () => {
    const violations = scanContentLocation({
      rootDir: ENGINE_ROOT,
      exclude: ENGINE_FIXTURE_EXCLUSIONS,
    });
    expect(formatContentViolations(violations)).toBe('');
  });
});

describe('guard: сканер границы контента ловит каждый вид документа', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'content-guard-'));
    mkdirSync(join(root, 'pkg-ts/src'), { recursive: true });
    mkdirSync(join(root, 'pkg-ts/node_modules/dep'), { recursive: true });
    mkdirSync(join(root, 'tests/golden'), { recursive: true });
    writeFileSync(join(root, 'pkg-ts/src/duel.scene.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/duel.presentation.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/duel.match.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/manifest.json'), '{}');
    writeFileSync(join(root, 'pkg-ts/src/hero.mdx'), '');
    writeFileSync(join(root, 'pkg-ts/src/skin.png'), '');
    // Не контент: исходники, манифест пакета, эталон прогона.
    writeFileSync(join(root, 'pkg-ts/src/index.ts'), '');
    writeFileSync(join(root, 'pkg-ts/package.json'), '{}');
    writeFileSync(join(root, 'tests/golden/movement.scenario.json'), '{}');
    writeFileSync(join(root, 'tests/golden/movement.golden.json'), '{}');
    // Чужой пакет в общем хранилище — не исходник репозитория.
    writeFileSync(join(root, 'pkg-ts/node_modules/dep/thing.scene.json'), '{}');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('сцена, парный слой, матч, манифест, модель и текстура краснят', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files).toEqual([
      'pkg-ts/src/duel.match.json',
      'pkg-ts/src/duel.presentation.json',
      'pkg-ts/src/duel.scene.json',
      'pkg-ts/src/hero.mdx',
      'pkg-ts/src/manifest.json',
      'pkg-ts/src/skin.png',
    ]);
  });

  it('исходники, манифест пакета и эталоны прогона не краснят', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files).not.toContain('pkg-ts/src/index.ts');
    expect(files).not.toContain('pkg-ts/package.json');
    expect(files).not.toContain('tests/golden/movement.scenario.json');
    expect(files).not.toContain('tests/golden/movement.golden.json');
  });

  it('node_modules не обходится: чужие пакеты — не исходники репозитория', () => {
    const files = scanContentLocation({ rootDir: root }).map((v) => v.file);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('освобождённая директория отсекается целиком', () => {
    const violations = scanContentLocation({
      rootDir: root,
      exclude: [{ dir: 'pkg-ts/src', reason: 'проверка освобождения' }],
    });
    expect(formatContentViolations(violations)).toBe('');
  });

  it('нарушение называет файл, правило и вид документа', () => {
    const [first] = scanContentLocation({ rootDir: root });
    expect(first!.rule).toBe('content-in-engine');
    expect(first!.message).toContain('конфиг матча');
    expect(first!.message).toContain('CONT-1');
    expect(first!.message).toContain('engine/tests/guard/contentLocation.ts');
  });
});
