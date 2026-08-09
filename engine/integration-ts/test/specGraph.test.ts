/**
 * Тест-на-формат для scripts/spec-graph.mjs (дизайн spec-graph-tool, D8).
 *
 * Парсер тула завязан на формат `### Requirement:`, который принадлежит
 * OpenSpec: апгрейд CLI, меняющий формат, должен ронять этот тест, а не
 * молча отдавать пустой граф. Живёт в кросс-слойной сюите по тому же
 * основанию, что contentBoundary: правило репозиторное, не пакетное.
 *
 * Числа требований здесь нет намеренно — спека растёт; вместо константы
 * парсер сверяется с независимым наивным сканом тех же файлов.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildModel,
  lint,
  loadLayers,
  type LayersConfig,
} from '../../../scripts/spec-graph.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SPECS_DIR = join(REPO_ROOT, 'openspec', 'specs');

describe('spec-graph: формат дерева спек не уехал', () => {
  const model = buildModel(SPECS_DIR);

  it('парсер находит столько же требований, сколько наивный скан заголовков', () => {
    let naive = 0;
    for (const entry of readdirSync(SPECS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const text = readFileSync(join(SPECS_DIR, entry.name, 'spec.md'), 'utf8');
      naive += text.split('\n').filter((l) => l.startsWith('### Requirement:')).length;
    }
    expect(model.requirements.size + model.duplicates.length).toBe(naive);
    expect(model.requirements.size).toBeGreaterThan(200);
  });

  it('ID уникальны, у каждого требования есть заголовок и тело', () => {
    expect(model.duplicates).toEqual([]);
    for (const req of model.requirements.values()) {
      expect(req.title, req.id).not.toBe('');
      expect(req.body.trim(), req.id).not.toBe('');
    }
  });

  it('у каждой capability есть Purpose', () => {
    for (const cap of model.capabilities.values()) {
      expect(cap.purpose, cap.name).not.toBe('');
    }
  });

  it('граф ссылок не пуст и не вырожден', () => {
    // ~1300 рёбер на текущем дереве; порог с запасом — от вырождения парсера,
    // а не от роста спеки.
    expect(model.edges.length).toBeGreaterThan(500);
    expect(model.capEdges.size).toBeGreaterThan(20);
  });

  it('конфиг слоёв покрывает все capability', () => {
    const layers = loadLayers();
    const findings = lint(model, layers);
    expect(findings.filter((f) => f.rule === 'unmapped-capability')).toEqual([]);
  });
});

describe('spec-graph: линт ловит каждый класс дефекта', () => {
  let dir: string;

  const LAYERS: LayersConfig = {
    order: ['foundation', 'top'],
    layers: { alpha: 'foundation', beta: 'top', 'game-content': 'top', editor: 'top' },
    exceptions: [],
  };

  const write = (cap: string, body: string) => {
    mkdirSync(join(dir, cap), { recursive: true });
    writeFileSync(join(dir, cap, 'spec.md'), body);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'spec-graph-fixture-'));
    write(
      'alpha',
      [
        '# Alpha',
        '## Purpose',
        'Фикстура.',
        '## Requirements',
        '### Requirement: AL-1 Висячая ссылка',
        'Это требование SHALL ссылаться на AL-99, которого нет, и на UTF-8 — незнакомый префикс.',
        '### Requirement: AL-2 Без модальности',
        'Описательный текст без нормы.',
        '### Requirement: AL-3 Неверная атрибуция',
        'Ссылка SHALL называть чужой дом: (`beta` AL-1) — а AL-1 определён в alpha.',
        '### Requirement: AL-4 Граница контента',
        'Механизм SHALL NOT знать политику, но ссылается на CONT-1.',
      ].join('\n'),
    );
    write(
      'beta',
      [
        '# Beta',
        '## Purpose',
        'Фикстура.',
        '## Requirements',
        '### Requirement: AL-1 Дубль ID из alpha',
        'Текст SHALL существовать.',
      ].join('\n'),
    );
    write(
      'game-content',
      [
        '# Content',
        '## Purpose',
        'Фикстура.',
        '## Requirements',
        '### Requirement: CONT-1 Контент',
        'Контент SHALL лежать в content/.',
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('по одному срабатыванию на каждый инвариант, и ничего лишнего', () => {
    const model = buildModel(dir);
    const findings = lint(model, LAYERS);
    const rules = findings.map((f) => f.rule).sort();

    // dangling: AL-99 (известный префикс) — да; UTF-8 (незнакомый) — нет.
    expect(rules.filter((r) => r === 'dangling')).toHaveLength(1);
    expect(findings.find((f) => f.rule === 'dangling')?.message).toContain('AL-99');
    expect(findings.some((f) => f.message.includes('UTF-8'))).toBe(false);

    expect(rules.filter((r) => r === 'duplicate-id')).toHaveLength(1);
    expect(rules.filter((r) => r === 'missing-modality')).toHaveLength(1);
    expect(findings.find((f) => f.rule === 'missing-modality')?.message).toContain('AL-2');

    expect(rules.filter((r) => r === 'attribution-mismatch')).toHaveLength(1);
    expect(findings.find((f) => f.rule === 'attribution-mismatch')?.message).toContain('beta');

    // content-boundary: alpha -> game-content; editor в фикстуре не ссылается.
    expect(rules.filter((r) => r === 'content-boundary')).toHaveLength(1);

    // Capability без слоя в конфиге нет — unmapped молчит.
    expect(rules.filter((r) => r === 'unmapped-capability')).toHaveLength(0);
  });

  it('unmapped-capability срабатывает на capability вне конфига слоёв', () => {
    const model = buildModel(dir);
    const findings = lint(model, { ...LAYERS, layers: { alpha: 'foundation' } });
    const unmapped = findings.filter((f) => f.rule === 'unmapped-capability');
    expect(unmapped.length).toBeGreaterThanOrEqual(2); // beta и game-content
  });
});
