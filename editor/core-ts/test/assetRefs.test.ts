/**
 * Правило «ссылка манифеста не разрешается в файл дерева» (ED-14) и индекс
 * дерева под ним (ED-12).
 *
 * ED-14 обещает автору три находки «до диска», и до этой работы третья —
 * «ссылка на отсутствующий ассет» — не проверялась ничем: существование файла
 * видно только тому, у кого есть дерево. `assets` ASSET-14 называет ту же
 * проверку своей обязанностью для эмиттерной ссылки.
 */
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession, type JsonValue } from '../src/document/index.js';
import { createMemoryHost } from '../src/host/index.js';
import { ContributionRegistry } from '../src/registry/index.js';
import {
  assetReferenceRule,
  createContentIndex,
  createValidator,
  registerValidationRules,
  ASSET_REFERENCE_RULE,
  type ContentIndex,
  type ValidationIssue,
  type ValidationRule,
} from '../src/validation/index.js';

const MANIFEST = 'visuals/manifest.json';

/** Индекс-дубль: перечисленное дерево из названных путей. */
function listed(...paths: readonly string[]): ContentIndex {
  const files = new Set(paths);
  return { listed: true, has: (path) => files.has(path) };
}

function issuesOf(value: JsonValue, index: ContentIndex): readonly ValidationIssue[] {
  const session: EditorSession = createEditorSession();
  session.openDocument({ id: MANIFEST, kind: 'manifest', value });
  const rules = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
  registerValidationRules(rules, [assetReferenceRule({ index, manifest: 'manifest' })]);
  return createValidator({ rules }).run(session).issues;
}

const HERO = 'visuals/models/hero.mdx';
const SKIN = 'visuals/textures/hero-red.png';
const EFFECT = 'visuals/effects/torch.effect.json';
const CURVATURE = 'visuals/terrain/curvature.json';

const FULL: JsonValue = {
  entities: { Hero: { model: HERO, skins: { red: { '0': SKIN } } } },
  decorations: { torch: { effect: EFFECT } },
  particles: { byEvent: { Exploded: { effect: EFFECT } } },
  terrain: { curvatureMap: CURVATURE },
};

describe('ED-14: ссылка манифеста на отсутствующий ассет видна до диска', () => {
  it('разрешающиеся ссылки находок не дают', () => {
    expect(issuesOf(FULL, listed(HERO, SKIN, EFFECT, CURVATURE))).toEqual([]);
  });

  it('модель записи адресуется своим путём, а причина называет ID ассета', () => {
    const found = issuesOf(FULL, listed(SKIN, EFFECT, CURVATURE));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: ASSET_REFERENCE_RULE,
      // Последствие в рантайме — заглушка с предупреждением (ASSET-4, ASSET-6),
      // и редактор последствия трёх находок ED-14 не уравнивает.
      severity: 'warning',
      documentId: MANIFEST,
      path: ['entities', 'Hero', 'model'],
      received: HERO,
      expected: { kind: 'presence', present: true },
      reasonParams: { asset: HERO },
    });
  });

  it('текстура слота скина проверяется наравне с моделью (REND-6)', () => {
    const found = issuesOf(FULL, listed(HERO, EFFECT, CURVATURE));
    expect(found.map((issue) => issue.path)).toEqual([['entities', 'Hero', 'skins', 'red', '0']]);
  });

  it('эмиттерные ссылки обеих секций проверяются наравне с моделью (ASSET-14)', () => {
    const found = issuesOf(FULL, listed(HERO, SKIN, CURVATURE));
    expect(found.map((issue) => issue.path)).toEqual([
      ['decorations', 'torch', 'effect'],
      ['particles', 'byEvent', 'Exploded', 'effect'],
    ]);
  });

  it('карта кривизны арены — такая же ссылка на ассет (ASSET-7)', () => {
    const found = issuesOf(FULL, listed(HERO, SKIN, EFFECT));
    expect(found.map((issue) => issue.path)).toEqual([['terrain', 'curvatureMap']]);
  });

  it('неперечисленное дерево — не «файла нет»: правило молчит (ED-12, ASSET-14)', () => {
    expect(issuesOf(FULL, { listed: false, has: () => false })).toEqual([]);
  });

  it('о сломанном манифесте говорит правило формата, а не это (ED-1)', () => {
    expect(issuesOf({ entities: { Hero: { model: 7 } } }, listed())).toEqual([]);
  });
});

describe('ED-12: индекс дерева контента', () => {
  it('до перечисления не знает ничего, после — знает файлы и не знает каталоги', async () => {
    const host = createMemoryHost({
      files: { [HERO]: new Uint8Array([1]), [SKIN]: new Uint8Array([2]) },
    });
    const index = createContentIndex(host.content);
    expect(index.listed).toBe(false);
    expect(index.has(HERO)).toBe(false);

    await index.refresh();
    expect(index.listed).toBe(true);
    expect(index.has(HERO)).toBe(true);
    expect(index.has(SKIN)).toBe(true);
    expect(index.has('visuals/models')).toBe(false);
    expect(index.has('visuals/models/ghost.mdx')).toBe(false);
  });

  it('появившийся и исчезнувший файл доезжают перечислением заново', async () => {
    const host = createMemoryHost({ files: { [HERO]: new Uint8Array([1]) } });
    const index = createContentIndex(host.content);
    await index.refresh();
    expect(index.has(SKIN)).toBe(false);

    await host.content.write(SKIN, new Uint8Array([2]));
    await index.refresh();
    expect(index.has(SKIN)).toBe(true);
  });

  it('отказ среды гасит индекс целиком, а не оставляет половину дерева', async () => {
    const host = createMemoryHost({ files: { [HERO]: new Uint8Array([1]) } });
    const index = createContentIndex({
      ...host.content,
      list: () => Promise.reject(new Error('перечисления в этой среде нет')),
    });
    await index.refresh();
    expect(index.listed).toBe(false);
    expect(index.has(HERO)).toBe(false);
  });

  it('смена корня забывает перечисленное: прежние пути относились к нему', async () => {
    const host = createMemoryHost({ files: { [HERO]: new Uint8Array([1]) } });
    const index = createContentIndex(host.content);
    await index.refresh();
    index.forget();
    expect(index.listed).toBe(false);
  });
});
