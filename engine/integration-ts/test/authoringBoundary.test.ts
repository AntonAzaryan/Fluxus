/**
 * Граница инструментов авторинга (`blender-pipeline` BLND-7, BLND-12): движок
 * не зависит от конвейера Blender, редактор знает о нём ровно сборкой, клиент
 * матча не обладает ни импортёром, ни каналом watch, а сам гейт проходит без
 * установленного Blender.
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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHORING_IMPORTS,
  HOT_CHANNEL_TEXT,
  PROCESS_LAUNCH_IMPORTS,
  WATCH_REFERENCES,
  formatAuthoringViolations,
  moduleSpecifiers,
  scanAuthoringBoundary,
  scanAuthoringDependencies,
  scanProcessLaunch,
} from '../../tests/guard/authoringBoundary.js';

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const EDITOR_ROOT = join(ENGINE_ROOT, '../editor');
const TOOLS_ROOT = join(ENGINE_ROOT, '../tools');
const REPO_ROOT = join(ENGINE_ROOT, '..');
const CLIENT_ROOT = join(ENGINE_ROOT, 'client-ts');

/**
 * Исключение одно, по пути и с причиной: этот файл цитирует запрещённые
 * импорты — иначе проверить сам сканер было бы нечем. Так же освобождает себя
 * от собственного правила сканер доменных имён редактора (`frameDomain.test.ts`
 * вырезает комментарии, цитирующие ED-25).
 */
const SELF = 'integration-ts/test/authoringBoundary.test.ts';

/**
 * Где редактору знать о конвейере ПОЗВОЛЕНО, и почему именно там.
 *
 * BLND-5 требует, чтобы командная строка и работающий редактор исполняли одну и
 * ту же зарегистрированную операцию, а BLND-2 — чтобы правка производных данных
 * подсвечивалась правилом-вкладом валидации редактора (ED-8, ED-25). И то и
 * другое регистрирует сборка (ED-25), поэтому пакет вклада она импортирует, а
 * манифест пакета объявляет его зависимостью.
 *
 * Перечень назван пофайлово намеренно: «редактор вправе» не должно расползтись
 * на headless-ядро редактора и на каркас интерфейса — им о конвейере знать
 * незачем, и появление там импорта обязано краснеть. Тест сюда же и смотрит с
 * другой стороны: перечисленное обязано импортировать пакет НА САМОМ ДЕЛЕ,
 * иначе исключение переживёт снятую регистрацию и разрешит будущий импорт молча.
 */
const EDITOR_ASSEMBLY: Readonly<Record<string, string>> = {
  'ui-ts/app/assembly.ts': 'сборка редактора: регистрация операции и правила-вклада (BLND-5, BLND-2)',
  'ui-ts/test/blenderSync.test.ts': 'проверка той самой регистрации на собранном редакторе',
};

/** Манифест, объявляющий пакет конвейера зависимостью, — тот же, что везёт сборку. */
const EDITOR_MANIFEST = 'ui-ts/package.json';

/**
 * Где подпроцесс в гейте законен — по пути и с причиной. Перечень пуст не будет
 * и не должен: CLI ядра проверяется запуском (CLI-9), иначе тест проверял бы то,
 * как модуль грузит vitest, а не то, как его грузит Node. Команда исключения
 * при этом проверяется отдельно — см. тест ниже.
 */
const PROCESS_LAUNCH_EXCEPTIONS: Readonly<Record<string, string>> = {
  'core-ts/test/cli.test.ts': 'запуск `bin/sim.mjs` интерпретатором Node — проверка CLI ядра (CLI-9)',
  'integration-ts/test/traceParity.test.ts':
    'запуск `bin/journal.mjs` интерпретатором Node — журнал боя собирается настоящей командой (CLI-12)',
};

describe('guard: конвейер Blender — не зависимость движка (BLND-7)', () => {
  it('ни один пакет движка не импортирует импортёр', () => {
    const violations = scanAuthoringBoundary({
      rootDir: ENGINE_ROOT,
      imports: AUTHORING_IMPORTS,
      exclude: [SELF],
    });
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('ни один манифест движка не объявляет его зависимостью', () => {
    expect(formatAuthoringViolations(scanAuthoringDependencies(ENGINE_ROOT))).toBe('');
  });
});

describe('guard: у редактора о конвейере знает только сборка (BLND-5, BLND-2)', () => {
  it('вне названных файлов сборки импортёр не импортируется', () => {
    const violations = scanAuthoringBoundary({
      rootDir: EDITOR_ROOT,
      imports: AUTHORING_IMPORTS,
      exclude: Object.keys(EDITOR_ASSEMBLY),
    });
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('исключения — не мёртвые: каждый названный файл вправду импортирует пакет', () => {
    for (const [file, why] of Object.entries(EDITOR_ASSEMBLY)) {
      const source = readFileSync(join(EDITOR_ROOT, file), 'utf8');
      expect(moduleSpecifiers(source), `${file}: ${why}`).toContain('@game-mvp/blender-ts');
    }
  });

  it('зависимость объявлена ровно одним манифестом редактора', () => {
    const violations = scanAuthoringDependencies(EDITOR_ROOT, AUTHORING_IMPORTS, [EDITOR_MANIFEST]);
    expect(formatAuthoringViolations(violations)).toBe('');
    // И она действительно есть: без неё исключение выше разрешало бы импорт
    // пакета, которого редактор не объявил своим.
    const manifest = JSON.parse(readFileSync(join(EDITOR_ROOT, EDITOR_MANIFEST), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@game-mvp/blender-ts');
  });
});

/**
 * BLND-7, сценарий «CI без Blender»: гейт зелёный там, где Blender не
 * установлен. Проверка импортов этого не даёт — бинарь зовут оболочкой, — и
 * закрывается он двумя каналами сразу (см. `scanProcessLaunch`).
 */
describe('guard: гейт не зовёт Blender ни одним каналом (BLND-7)', () => {
  it('ни один скрипт манифеста не запускает бинарь Blender', () => {
    expect(formatAuthoringViolations(scanProcessLaunch(REPO_ROOT))).toBe('');
  });

  it('подпроцесс в гейте запускает ровно один названный файл', () => {
    // Движок, редактор и сам импортёр: без подпроцесса Blender не позвать ни
    // под каким именем, и перечень мест, где подпроцесс вообще есть, короче и
    // проверяемее перечня имён бинарей. Аддон (`tools/blender-addon/`) — Python,
    // вне workspace и вне гейта, и его вызов Node сюда не попадает.
    for (const root of [ENGINE_ROOT, EDITOR_ROOT, join(TOOLS_ROOT, 'blender-ts')]) {
      const violations = scanAuthoringBoundary({
        rootDir: root,
        imports: PROCESS_LAUNCH_IMPORTS,
        exclude: [SELF, ...Object.keys(PROCESS_LAUNCH_EXCEPTIONS)],
      });
      expect(formatAuthoringViolations(violations), root).toBe('');
    }
  });

  it('и запускает он интерпретатор Node, а не имя из строки', () => {
    // Исключение проверяется, а не даётся на слово: подпроцесс там один, и его
    // команда — `process.execPath`. Собранное из строки имя бинаря прошло бы
    // мимо сканера импортов, и тогда «гейт Blender не зовёт» держалось бы на
    // ревью.
    for (const file of Object.keys(PROCESS_LAUNCH_EXCEPTIONS)) {
      const source = readFileSync(join(ENGINE_ROOT, file), 'utf8');
      const launches = [...source.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*([^,)]+)/g)];
      expect(launches.length, file).toBeGreaterThan(0);
      for (const [, command] of launches) expect(command?.trim(), file).toBe('process.execPath');
    }
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
      JSON.stringify({
        dependencies: { '@game-mvp/blender-ts': '*' },
        scripts: {
          // Команда Blender'ом: ровно то, чего в гейте быть не должно.
          export: 'blender --background scene.blend',
          // А это — не он: путь пакета и имя workspace, в которых слово стоит
          // частью имени, а не командой.
          import: 'node tools/blender-ts/bin/import.mjs',
          test: 'npm run test -w @game-mvp/blender-ts',
        },
      }),
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

  it('названный манифест из проверки зависимостей исключается по пути', () => {
    const violations = scanAuthoringDependencies(root, AUTHORING_IMPORTS, ['pkg-ts/package.json']);
    expect(formatAuthoringViolations(violations)).toBe('');
  });

  it('команда Blender краснит, а имя пакета в скрипте — нет', () => {
    const violations = scanProcessLaunch(root);
    expect(violations.map((violation) => violation.file)).toEqual(['pkg-ts/package.json']);
    // Красный ровно один скрипт: `import` и `test` называют пакет, а не бинарь.
    expect(violations).toHaveLength(1);
    expect(violations[0]!.message).toContain('"export"');
    expect(violations[0]!.rule).toBe('blender-in-gate');
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
