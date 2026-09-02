/**
 * Тесты карты влияния и выборки — scripts/impact.mjs (change gate-impact-mapping).
 *
 * Карта отвечает на три вопроса: под какое правило подходит путь, какие пакеты
 * тянет изменившийся пакет и во что это складывается планом прогона. Здесь
 * проверяется каждый из них — на фикстурных диффах и на настоящем графе
 * репозитория; полноту самой карты (все ли пакеты и корни ею названы, не читает
 * ли тест чужое дерево мимо неё) держит соседний impactMap.test.ts.
 *
 * Живёт в кросс-слойной сюите по тому же основанию, что contentBoundary и
 * specGraph: правило репозиторное, а не пакетное, и пакета у него нет вовсе.
 *
 * Норма — CLI-14 (выборочный прогон по карте влияния) и инвариант стадий
 * CLI-13; названия сценариев взяты из текста требования дословно.
 */
import { describe, expect, it } from 'vitest';
import {
  classify,
  closure,
  planFor,
  snapshotDiff,
  stagesFor,
  TEST_EDGES,
  type Plan,
} from '../../../scripts/impact.mjs';
import { loadWorkspaces, type WorkspacePackage } from '../../../scripts/workspaces.mjs';

const WORKSPACES = loadWorkspaces();

/**
 * Синтетический workspace для сценариев, которых на настоящем дереве сегодня
 * нет: листовой пакет (от него не зависит никто и его дерево не читает ни один
 * чужой тест) в репозитории один — сама интеграционная сюита, и сценарий на ней
 * выродился бы. Фикстура называет пакеты так же, как это делает манифест, чтобы
 * проверялась та же функция, а не её упрощение.
 */
const FIXTURE: WorkspacePackage[] = [
  { dir: 'engine/core-ts', name: '@fluxus/core', deps: [] },
  { dir: 'engine/leaf-ts', name: '@fluxus/leaf', deps: ['@fluxus/core'] },
  { dir: 'engine/read-ts', name: '@fluxus/read', deps: [] },
  { dir: 'engine/integration-ts', name: '@fluxus/integration', deps: ['@fluxus/core'] },
  { dir: 'game/reader-ts', name: '@fluxus/reader', deps: [] },
];
/** Чужой тест читает дерево `engine/read-ts` мимо манифеста. */
const FIXTURE_EDGES = { 'game/reader-ts': ['engine/read-ts'] };

const dirs = (plan: Plan): string[] => plan.packages.map((p) => p.dir).sort();

describe('карта влияния: классификация путей', () => {
  it('широкие ворота дают полный гейт: контент, эталоны, схемы, скрипты, обвязка', () => {
    const wide = [
      'content/scenes/duel.scene.json',
      'engine/tests/golden/match-walk.golden.json',
      'engine/schemas/systems.schema.json',
      'scripts/impact.mjs',
      '.claude/hooks/guard-bash.mjs',
      'tools/blender-addon/__init__.py',
    ];
    for (const path of wide) {
      expect(classify(path, WORKSPACES).kind, path).toBe('full');
    }
  });

  it('корневые конфиги, любой tsconfig, манифест и lock-файл — тоже широкие ворота', () => {
    const configs = [
      'package.json',
      'package-lock.json',
      'eslint.config.js',
      'vitest.gate.config.ts',
      'engine/core-ts/tsconfig.json',
      'engine/core-ts/package.json',
    ];
    for (const path of configs) {
      expect(classify(path, WORKSPACES).kind, path).toBe('full');
    }
  });

  it('спеки, документация и markdown — документный класс', () => {
    for (const path of ['openspec/specs/cli-testing/spec.md', 'docs/architecture.md', 'CLAUDE.md']) {
      expect(classify(path, WORKSPACES).kind, path).toBe('docs');
    }
  });

  it('путь внутри пакета относится к этому пакету', () => {
    const found = classify('engine/core-ts/src/sim/tick.ts', WORKSPACES);
    expect(found.kind).toBe('pkg');
    expect(found.pkg).toBe('engine/core-ts');
    expect(classify('game/demo-ts/app/main.ts', WORKSPACES).pkg).toBe('game/demo-ts');
  });

  it('неизвестный путь даёт полный гейт, а не пустую выборку (fail-closed)', () => {
    const found = classify('warehouse/unknown/file.ts', WORKSPACES);
    expect(found.kind).toBe('full');
    expect(found.rule).toBe('unknown');
  });
});

describe('карта влияния: обратное замыкание', () => {
  it('правка ядра тянет всё, кроме пакета ассетов: он от ядра не зависит вовсе', () => {
    const selected = [...closure(['engine/core-ts'], WORKSPACES).keys()].sort();
    const everything = WORKSPACES.map((w) => w.dir).sort();
    expect(selected).toEqual(everything.filter((dir) => dir !== 'engine/assets-ts'));
  });

  it('правка редактора тянет десктоп-контейнер по тест-ребру и интеграционную сюиту', () => {
    const selected = closure(['editor/ui-ts'], WORKSPACES);
    expect([...selected.keys()].sort()).toEqual(['desktop/shell-ts', 'editor/ui-ts', 'engine/integration-ts']);
    expect(selected.get('desktop/shell-ts')).toContain('тест-ребро');
  });

  it('правка сборки игры тянет агента хоста и контейнер — оба по тест-рёбрам', () => {
    const selected = closure(['game/demo-ts'], WORKSPACES);
    expect([...selected.keys()].sort()).toEqual([
      'desktop/shell-ts',
      'engine/integration-ts',
      'game/demo-ts',
      'game/server-agent-ts',
    ]);
  });

  it('тест-ребро не транзитивно: за контейнером не тянутся его потребители', () => {
    // Сборка игры и менеджер зависят от контейнера по манифесту, но правка
    // редактора меняет не код контейнера, а лишь то, что читают его тесты.
    const selected = closure(['editor/ui-ts'], WORKSPACES);
    expect(selected.has('game/demo-ts')).toBe(false);
    expect(selected.has('game/server-manager-ts')).toBe(false);
  });

  it('пустая выборка остаётся пустой: интеграционная сюита добавляется только к непустой', () => {
    expect(closure([], WORKSPACES).size).toBe(0);
  });
});

describe('карта влияния: сценарии выборочного прогона', () => {
  it('правка контента даёт полный гейт', () => {
    const plan = planFor(['content/scenes/duel.scene.json'], WORKSPACES);
    expect(plan.kind).toBe('full');
    expect(stagesFor(plan).map((s) => s.name)).toEqual([
      'typecheck',
      'lint',
      'lint:dead',
      'lint:dup',
      'lint:arch',
      'spec-graph',
      'test',
    ]);
  });

  it('правка листового пакета: он сам и интеграционная сюита, остальные не запускаются', () => {
    const plan = planFor(['engine/leaf-ts/src/index.ts'], FIXTURE, FIXTURE_EDGES);
    expect(plan.kind).toBe('selective');
    expect(dirs(plan)).toEqual(['engine/integration-ts', 'engine/leaf-ts']);
    expect(plan.test).toEqual(['@fluxus/integration', '@fluxus/leaf']);
    // Глобальные по природе проверки — целиком при любой выборке.
    expect(stagesFor(plan).map((s) => s.name)).toContain('lint:dead');
    expect(stagesFor(plan).map((s) => s.name)).toContain('lint:arch');
  });

  it('правка пакета, чьё дерево читает чужой тест: читающий входит по тест-ребру', () => {
    const plan = planFor(['engine/read-ts/src/index.ts'], FIXTURE, FIXTURE_EDGES);
    expect(dirs(plan)).toEqual(['engine/integration-ts', 'engine/read-ts', 'game/reader-ts']);
    expect(plan.packages.find((p) => p.dir === 'game/reader-ts')?.why).toContain('тест-ребро');
  });

  it('менеджер сервера на настоящем дереве тянет контейнер: его профили проверяют пути менеджера', () => {
    const plan = planFor(['game/server-manager-ts/src/index.ts'], WORKSPACES);
    expect(dirs(plan)).toEqual(['desktop/shell-ts', 'engine/integration-ts', 'game/server-manager-ts']);
  });

  it('документный дифф: линт графа спек и тесты, читающие дерево спек', () => {
    const plan = planFor(['openspec/specs/cli-testing/spec.md', 'docs/architecture.md'], WORKSPACES);
    expect(plan.kind).toBe('docs');
    expect(plan.packages).toEqual([]);
    expect(stagesFor(plan).map((s) => s.name)).toEqual(['spec-graph', 'test']);
    expect(stagesFor(plan)[1]?.cmd[1]).toContain('specGraph');
  });

  it('неизвестный корень: любой дифф с ним даёт полный гейт', () => {
    const plan = planFor(['engine/core-ts/src/sim/tick.ts', 'warehouse/box.ts'], WORKSPACES);
    expect(plan.kind).toBe('full');
  });

  it('пустой дифф: только глобальные проверки', () => {
    const plan = planFor([], WORKSPACES);
    expect(plan.kind).toBe('global-only');
    expect(stagesFor(plan).map((s) => s.name)).toEqual(['lint:dead', 'lint:dup', 'lint:arch', 'spec-graph']);
  });

  it('таблица тест-рёбер называет только пакеты workspace', () => {
    const known = new Set(WORKSPACES.map((w) => w.dir));
    for (const [reader, read] of Object.entries(TEST_EDGES)) {
      expect(known.has(reader), reader).toBe(true);
      for (const dir of read) expect(known.has(dir), dir).toBe(true);
    }
  });
});

describe('инвариант стадий: прогон не пишет в дерево', () => {
  const patchFor = (path: string, body: string): string =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}`;

  it('совпадающие снимки рабочего дерева расхождений не дают', () => {
    const snapshot = {
      status: ' M engine/core-ts/src/sim/tick.ts\n?? runs/latest/trace.jsonl\n',
      patch: patchFor('engine/core-ts/src/sim/tick.ts', '+const tick = 1;'),
    };
    expect(snapshotDiff(snapshot, snapshot)).toEqual([]);
    expect(snapshotDiff({ status: '', patch: '' }, { status: '', patch: '' })).toEqual([]);
  });

  it('файл, появившийся или исчезнувший за прогон, попадает в расхождение', () => {
    const before = { status: ' M engine/core-ts/src/sim/tick.ts\n', patch: '' };
    const after = {
      status: ' M engine/core-ts/src/sim/tick.ts\n M engine/tests/golden/walk.golden.json\n',
      patch: '',
    };
    expect(snapshotDiff(before, after)).toEqual(['+  M engine/tests/golden/walk.golden.json']);
    expect(snapshotDiff(after, before)).toEqual(['-  M engine/tests/golden/walk.golden.json']);
  });

  it('перезапись УЖЕ грязного файла краснеет: статусная строка та же, содержимое другое', () => {
    // Ровно тот случай, ради которого снимок не ограничен статусом: эталон,
    // регенерированный поверх правки разработчика, статуса ` M` не меняет.
    const status = ' M engine/tests/golden/walk.golden.json\n';
    const path = 'engine/tests/golden/walk.golden.json';
    const before = { status, patch: patchFor(path, '+"tick": 1') };
    const after = { status, patch: patchFor(path, '+"tick": 2') };
    expect(snapshotDiff(before, after)).toEqual([`~ ${path} — содержимое изменилось`]);
  });

  it('чужой файл, изменившийся в том же прогоне, назван отдельно от неизменного', () => {
    const status = ' M a.ts\n M b.ts\n';
    const kept = patchFor('a.ts', '+const a = 1;');
    const before = { status, patch: `${kept}\n${patchFor('b.ts', '+const b = 1;')}` };
    const after = { status, patch: `${kept}\n${patchFor('b.ts', '+const b = 2;')}` };
    expect(snapshotDiff(before, after)).toEqual(['~ b.ts — содержимое изменилось']);
  });
});
