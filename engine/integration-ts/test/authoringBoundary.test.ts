/**
 * Граница инструментов авторинга (`blender-pipeline` BLND-7, BLND-12): движок и
 * редактор не зависят от конвейера Blender, а клиент матча не обладает ни
 * импортёром, ни каналом watch.
 *
 * Проверка живёт в кросс-слойной сюите по той же причине, что и граница
 * контента: правило репозиторное — оно про то, чего НЕ должно быть в чужих
 * пакетах, — а `integration-ts` единственная видит их все сразу. Сканер общий
 * (`engine/tests/guard/authoringBoundary.ts`); здесь конфигурация и тесты
 * самого сканера.
 *
 * Утверждение сценария BLND-12 «Матчевый клиент и watch» без такой проверки
 * держалось бы на ревью: watch-режим стоит одного `fs.watch` в оболочке
 * клиента, и появиться он может ровно там, где кому-то надоест перезапускать
 * демо.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHORING_IMPORTS,
  HOT_CHANNEL_TEXT,
  WATCH_REFERENCES,
  formatAuthoringViolations,
  moduleSpecifiers,
  scanAuthoringBoundary,
  scanAuthoringDependencies,
} from '../../tests/guard/authoringBoundary.js';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EDITOR_ROOT = join(ENGINE_ROOT, '../editor');
const CLIENT_ROOT = join(ENGINE_ROOT, 'client-ts');

/**
 * Исключение одно, по пути и с причиной: этот файл цитирует запрещённые
 * импорты — иначе проверить сам сканер было бы нечем. Так же освобождает себя
 * от собственного правила сканер доменных имён редактора (`frameDomain.test.ts`
 * вырезает комментарии, цитирующие ED-25).
 */
const SELF = 'integration-ts/test/authoringBoundary.test.ts';

describe('guard: конвейер Blender — не зависимость движка и редактора (BLND-7)', () => {
  it('ни один пакет движка не импортирует импортёр', () => {
    const violations = scanAuthoringBoundary({
      rootDir: ENGINE_ROOT,
      imports: AUTHORING_IMPORTS,
      exclude: [SELF],
    });
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('ни один пакет редактора не импортирует импортёр', () => {
    const violations = scanAuthoringBoundary({ rootDir: EDITOR_ROOT, imports: AUTHORING_IMPORTS });
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('ни один манифест движка и редактора не объявляет его зависимостью', () => {
    expect(formatAuthoringViolations(scanAuthoringDependencies(ENGINE_ROOT))).toBe('');
    expect(formatAuthoringViolations(scanAuthoringDependencies(EDITOR_ROOT))).toBe('');
  });
});

describe('guard: у клиента матча нет канала watch (BLND-12)', () => {
  it('клиент не следит за файлами и не слушает канал переподачи', () => {
    const violations = scanAuthoringBoundary({
      rootDir: CLIENT_ROOT,
      imports: [...AUTHORING_IMPORTS, ...WATCH_REFERENCES],
      text: HOT_CHANNEL_TEXT,
      // Конфиг сборки демо — оболочка вокруг клиента, а не он сам: `vite`
      // читает файлы по определению, и запрещать ему это значило бы запрещать
      // сборку. Клиент — это `src/` и код демо, и именно они сканируются.
      exclude: ['demo/vite.config.ts'],
    });
    expect(formatAuthoringViolations(violations)).toBe('');
  });
});

describe('guard: сканер границы авторинга ловит то, что объявил', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'authoring-guard-'));
    mkdirSync(join(root, 'pkg-ts/src'), { recursive: true });
    mkdirSync(join(root, 'pkg-ts/node_modules/dep'), { recursive: true });
    writeFileSync(
      join(root, 'pkg-ts/src/importing.ts'),
      "import { runImport } from '@game-mvp/blender-ts';\n",
    );
    writeFileSync(
      join(root, 'pkg-ts/src/relative.ts'),
      "const tool = await import('../../../tools/blender-ts/src/cli.js');\n",
    );
    writeFileSync(join(root, 'pkg-ts/src/watching.ts'), "import { watch } from 'node:fs';\n");
    writeFileSync(join(root, 'pkg-ts/src/hot.ts'), 'if (import.meta.hot) location.reload();\n');
    // Не нарушения: комментарий про конвейер и обычные импорты рантайма.
    writeFileSync(
      join(root, 'pkg-ts/src/clean.ts'),
      "// импорт из @game-mvp/blender-ts здесь только в комментарии\nimport { tick } from '@game-mvp/core';\n",
    );
    // Чужой пакет в общем хранилище — не исходник репозитория.
    writeFileSync(
      join(root, 'pkg-ts/node_modules/dep/index.ts'),
      "import x from '@game-mvp/blender-ts';\n",
    );
    writeFileSync(
      join(root, 'pkg-ts/package.json'),
      JSON.stringify({ dependencies: { '@game-mvp/blender-ts': '*' } }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('импорт пакета конвейера и путь в tools/ краснят оба', () => {
    const files = scanAuthoringBoundary({ rootDir: root, imports: AUTHORING_IMPORTS }).map(
      (violation) => violation.file,
    );
    expect(files).toEqual(['pkg-ts/src/importing.ts', 'pkg-ts/src/relative.ts']);
  });

  it('слежение за файлами и канал dev-сервера краснят по своим спискам', () => {
    const violations = scanAuthoringBoundary({
      rootDir: root,
      imports: WATCH_REFERENCES,
      text: HOT_CHANNEL_TEXT,
    });
    expect(violations.map((violation) => violation.file)).toEqual([
      'pkg-ts/src/hot.ts',
      'pkg-ts/src/watching.ts',
    ]);
    expect(violations[0]!.rule).toBe('watch-in-match-client');
    expect(violations[0]!.message).toContain('BLND-12');
  });

  it('упоминание в комментарии зависимостью не является', () => {
    const files = scanAuthoringBoundary({ rootDir: root, imports: AUTHORING_IMPORTS }).map(
      (violation) => violation.file,
    );
    expect(files).not.toContain('pkg-ts/src/clean.ts');
  });

  it('node_modules не обходится: чужие пакеты — не исходники репозитория', () => {
    const files = scanAuthoringBoundary({ rootDir: root, imports: AUTHORING_IMPORTS }).map(
      (violation) => violation.file,
    );
    expect(files.some((file) => file.includes('node_modules'))).toBe(false);
  });

  it('зависимость манифеста видна и без единого импорта', () => {
    const violations = scanAuthoringDependencies(root);
    expect(violations.map((violation) => violation.file)).toEqual(['pkg-ts/package.json']);
    expect(violations[0]!.message).toContain('BLND-7');
  });

  it('сканер берёт спецификаторы всех четырёх форм', () => {
    const source = [
      "import a from 'one';",
      "export { b } from 'two';",
      "const c = await import('three');",
      "const d = require('four');",
      "import 'five';",
    ].join('\n');
    expect(moduleSpecifiers(source).sort()).toEqual(['five', 'four', 'one', 'three', 'two']);
  });
});
