/**
 * Независимость десктоп-контейнера от движка и редактора (`desktop-shell`
 * DSK-3): пакет контейнера не импортирует пакеты движка и редактора и не
 * объявляет их зависимостями.
 *
 * Проверка живёт в кросс-слойной сюите по той же причине, что граница контента
 * (CONT-1) и граница авторинга (BLND-7): правило репозиторное — оно про то,
 * чего НЕ должно быть в чужом пакете, — а `integration-ts` единственная видит
 * их все сразу. Сканер общий (`engine/tests/guard/authoringBoundary.ts`): он
 * про спецификаторы модулей, а не про конкретный запрет, и второй такой же
 * обход дерева здесь не заводится.
 *
 * Без этой проверки DSK-3 держался бы на ревью, а ломается он дёшево: одна
 * строка `import type { ... } from '@fluxus/core'` в клее контейнера — и
 * рефакторинг движка начинает требовать пересборки оболочки, ровно того, чего
 * требование не допускает.
 *
 * Обратное направление — приложение → контракт моста — законно и запретом не
 * покрывается: `editor/ui-ts` импортирует типы `@fluxus/desktop-shell/bridge`
 * своим адаптером хостового шва (ED-12), и это зависимость приложения от
 * ГРАНИЦЫ, а не контейнера от движка. Здесь проверяется обратное: адаптер
 * лежит у редактора и говорит на типах шва, а имён этого шва в контейнере нет
 * ни одного — переехать через границу он не начал (DSK-2).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatAuthoringViolations,
  scanAuthoringBoundary,
  scanAuthoringDependencies,
  type ForbiddenReference,
} from '../../tests/guard/authoringBoundary.js';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP_ROOT = join(ENGINE_ROOT, '../desktop');
const EDITOR_ROOT = join(ENGINE_ROOT, '../editor');

/** Адаптер десктопного хоста: он живёт у приложения, а не у контейнера (DSK-2). */
const EDITOR_ADAPTER = 'ui-ts/src/host/desktop.ts';

/**
 * Чего контейнеру нельзя. Три записи, а не одна: имя пакета ловит обычный
 * импорт, а два пути — тот же импорт мимо имени пакета (`../../engine/...`),
 * которым запрет обходится первым делом. Ведущий слэш обязателен — без него
 * запись краснила бы на собственных модулях контейнера вроде `./editor/x.js`.
 */
const CONTAINER_IMPORTS: readonly ForbiddenReference[] = [
  {
    match: '@fluxus/',
    rule: 'engine-in-container',
    why: 'контейнер не зависит от пакетов движка и редактора (DSK-3)',
  },
  {
    match: '/engine/',
    rule: 'engine-in-container',
    why: 'пакет движка мимо имени пакета — та же зависимость (DSK-3)',
  },
  {
    match: '/editor/',
    rule: 'engine-in-container',
    why: 'пакет редактора мимо имени пакета — та же зависимость (DSK-3)',
  },
];

describe('guard: контейнер не зависит от движка и редактора (DSK-3)', () => {
  it('ни один модуль контейнера не импортирует пакеты движка и редактора', () => {
    const violations = scanAuthoringBoundary({ rootDir: DESKTOP_ROOT, imports: CONTAINER_IMPORTS });
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('манифест контейнера не объявляет их зависимостями', () => {
    // Зависимость без единого импорта сканер спецификаторов не увидит, а DSK-3
    // запрещает именно зависимость.
    const violations = scanAuthoringDependencies(DESKTOP_ROOT, CONTAINER_IMPORTS);
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('адаптер хостового шва лежит на стороне редактора, а не в контейнере (DSK-2)', () => {
    // DSK-2: «адаптеры, превращающие мост в предметные интерфейсы приложений,
    // SHALL жить на стороне приложений; контейнер MUST NOT содержать их
    // реализации». Проверяется с обеих сторон: адаптер есть у редактора и
    // говорит на типах шва, а имён шва в контейнере нет ни одного.
    const adapter = readFileSync(join(EDITOR_ROOT, EDITOR_ADAPTER), 'utf8');
    expect(adapter).toContain('EnvironmentHost');
    const leaked = scanAuthoringBoundary({
      rootDir: DESKTOP_ROOT,
      text: [
        {
          match: 'EnvironmentHost',
          rule: 'editor-seam-in-container',
          why: 'шов среды редактора — предметный интерфейс приложения (DSK-2, ED-12)',
        },
        {
          match: 'ContentTreeHost',
          rule: 'editor-seam-in-container',
          why: 'дерево контента редактора — предметный интерфейс приложения (DSK-2)',
        },
      ],
    });
    expect(formatAuthoringViolations(leaked)).toBe('');
  });
});

describe('guard: запрет для контейнера ловит то, что объявил', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'container-guard-'));
    mkdirSync(join(root, 'shell-ts/src/electron'), { recursive: true });
    mkdirSync(join(root, 'shell-ts/build/game/assets'), { recursive: true });
    writeFileSync(join(root, 'shell-ts/src/named.ts'), "import { tick } from '@fluxus/core';\n");
    writeFileSync(
      join(root, 'shell-ts/src/relative.ts'),
      "import { createWebHost } from '../../../editor/ui-ts/src/host/web.js';\n",
    );
    writeFileSync(
      join(root, 'shell-ts/src/deep.ts'),
      "const core = await import('../../engine/core-ts/src/index.js');\n",
    );
    // Клей контейнера не весь на `.ts`: preload исполняется в песочнице
    // Electron, где `require` соседнего модуля недоступен, а конфиг упаковщика
    // читает сам упаковщик — оба вынужденно на CommonJS. `require` оттуда —
    // ровно та же зависимость, что импорт из `.ts`.
    writeFileSync(
      join(root, 'shell-ts/src/electron/preload.cjs'),
      "const { tick } = require('@fluxus/core');\n",
    );
    writeFileSync(
      join(root, 'shell-ts/electron-builder.cjs'),
      "const version = require('../../engine/core-ts/package.json').version;\n",
    );
    writeFileSync(
      join(root, 'shell-ts/src/tool.js'),
      "import { createEditor } from '../../editor/core-ts/src/index.js';\n",
    );
    // Артефакт сборки — не код пакета: собранный бандл это чужие модули,
    // слитые в один файл, и запрет на импорт к нему неприменим.
    writeFileSync(
      join(root, 'shell-ts/build/game/assets/index.js'),
      "import { tick } from '@fluxus/core';\n",
    );
    // Не нарушения: собственные модули контейнера и упоминание в комментарии.
    writeFileSync(
      join(root, 'shell-ts/src/electron/clean.cjs'),
      "const { contextBridge } = require('electron');\nmodule.exports = { contextBridge };\n",
    );
    writeFileSync(
      join(root, 'shell-ts/src/clean.ts'),
      [
        '// мост не знает про @fluxus/core — это комментарий, а не зависимость',
        "import { createHostRoot } from './host/root.js';",
        "import { app } from 'electron';",
        'export const use = [createHostRoot, app];',
      ].join('\n'),
    );
    writeFileSync(
      join(root, 'shell-ts/package.json'),
      JSON.stringify({ name: '@fluxus/desktop-shell', devDependencies: { electron: '^43.0.0' } }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('имя пакета и путь в обход имени краснят одинаково', () => {
    const files = scanAuthoringBoundary({ rootDir: root, imports: CONTAINER_IMPORTS }).map((v) => v.file);
    expect(files).toEqual([
      'shell-ts/electron-builder.cjs',
      'shell-ts/src/deep.ts',
      'shell-ts/src/electron/preload.cjs',
      'shell-ts/src/named.ts',
      'shell-ts/src/relative.ts',
      'shell-ts/src/tool.js',
    ]);
  });

  it('запрет видит и CommonJS-клей, и `.js` (DSK-3)', () => {
    // Проверка живёт отдельным утверждением, потому что дыра здесь и была:
    // сканер открывал только `.ts`, `.mts` и `.mjs`, а `preload.cjs` и
    // `electron-builder.cjs` не открывал вовсе. Запрет, слепой к части пакета,
    // — это соглашение ревью, а не «закреплена автоматической проверкой в
    // гейте», как того требует DSK-3.
    const files = scanAuthoringBoundary({ rootDir: root, imports: CONTAINER_IMPORTS }).map((v) => v.file);
    expect(files).toContain('shell-ts/src/electron/preload.cjs');
    expect(files).toContain('shell-ts/electron-builder.cjs');
    expect(files).toContain('shell-ts/src/tool.js');
  });

  it('собственные модули контейнера, Electron и артефакты сборки не краснят', () => {
    const files = scanAuthoringBoundary({ rootDir: root, imports: CONTAINER_IMPORTS }).map((v) => v.file);
    expect(files).not.toContain('shell-ts/src/clean.ts');
    expect(files).not.toContain('shell-ts/src/electron/clean.cjs');
    expect(files).not.toContain('shell-ts/build/game/assets/index.js');
  });

  it('нарушение называет файл, правило и требование', () => {
    const violations = scanAuthoringBoundary({ rootDir: root, imports: CONTAINER_IMPORTS });
    const first = violations.find((v) => v.file === 'shell-ts/src/named.ts');
    expect(first!.rule).toBe('engine-in-container');
    expect(first!.message).toContain('DSK-3');
  });

  it('манифест с зависимостью от движка виден и без единого импорта', () => {
    writeFileSync(
      join(root, 'shell-ts/package.json'),
      JSON.stringify({ dependencies: { '@fluxus/core': '*' } }),
    );
    const violations = scanAuthoringDependencies(root, CONTAINER_IMPORTS);
    expect(violations.map((v) => v.file)).toEqual(['shell-ts/package.json']);
  });
});
