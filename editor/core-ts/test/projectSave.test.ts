/**
 * Канонический round-trip сохранения (ED-21) и согласованность тройки ED-19.
 *
 * Пиннится на настоящих документах дерева контента — `content/scenes/duel.scene.json`
 * и `content/matches/duel.match.json`, — а не на игрушечной фикстуре: ED-21
 * говорит о файлах проекта, и свойство «байт-в-байт» на документе из трёх полей
 * не значит ничего. Дерево читается только на чтение: правки уходят в хост в
 * памяти, в `content/` не пишется ни байта (CONT-1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createEditorSession, type EditorSession } from '../src/document/index.js';
import { createOperationRegistry, registerBuiltinOperations } from '../src/operations/index.js';
import { createMemoryHost, type MemoryHost } from '../src/host/index.js';
import {
  canonicalizeDocument,
  decodeDocument,
  encodeDocument,
  isCanonicalDocument,
  openDocumentFromHost,
  saveDocuments,
  scenePairingSave,
  type ScenePairing,
} from '../src/project/index.js';
import type { JsonValue } from '../src/document/json.js';

const decoder = new TextDecoder();

function contentFile(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../content/${relative}`, import.meta.url))));
}

const SCENE_PATH = 'scenes/duel.scene.json';
const MATCH_PATH = 'matches/duel.match.json';
const MANIFEST_PATH = 'visuals/manifest.json';

const SCENE_ON_DISK = contentFile('scenes/duel.scene.json');
const MATCH_ON_DISK = contentFile('matches/duel.match.json');
const MANIFEST_ON_DISK = contentFile('visuals/manifest.json');

function newSession(): EditorSession {
  return createEditorSession({ operations: registerBuiltinOperations(createOperationRegistry()) });
}

/** Номера строк, различающихся в двух текстах, — то, что автор увидит диффом. */
function changedLines(before: string, after: string): number[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const changed: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(i);
  return changed;
}

describe('ED-21: «открыл — сохранил без правок» не меняет ни байта', () => {
  it('сцена из дерева контента остаётся на диске побайтово прежней', async () => {
    const host = createMemoryHost({ files: { [SCENE_PATH]: SCENE_ON_DISK } });
    const before = host.bytes(SCENE_PATH);
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene' });

    const result = await saveDocuments({ session, host: host.content });

    // Пустой дифф получается не совпадением байтов, а отсутствием записи:
    // сохранение затрагивает только документы, в которых есть правки.
    expect(result).toMatchObject({ refused: false, written: [] });
    expect(host.writes).toEqual([]);
    expect(host.bytes(SCENE_PATH)).toEqual(before);
  });

  it('документ дерева контента канонической формы редактора не имеет — и это видно вызывающему', () => {
    expect(isCanonicalDocument(SCENE_ON_DISK)).toBe(false);
    // Первое сохранение приведёт файл к канонической форме; дальше она — точка
    // покоя, и «открыл — сохранил» диффа не даёт уже побайтово.
    const canonical = canonicalizeDocument(SCENE_ON_DISK);
    expect(isCanonicalDocument(canonical)).toBe(true);
    expect(canonicalizeDocument(canonical)).toEqual(canonical);
    // Приведение к канонической форме ничего не теряет: значение то же.
    expect(decodeDocument(canonical)).toEqual(decodeDocument(SCENE_ON_DISK));
  });

  it('правка и возврат значения дают байт-в-байт тот же файл', async () => {
    const canonical = canonicalizeDocument(SCENE_ON_DISK);
    const host = createMemoryHost({ files: { [SCENE_PATH]: canonical } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene' });

    const path = ['prefabs', 0, 'components', 'Locomotion', 'maxSpeed'];
    session.applyOperation('document.setValue', { document: SCENE_PATH, path, value: 5000 });
    session.applyOperation('document.setValue', { document: SCENE_PATH, path, value: 5243 });

    const result = await saveDocuments({ session, host: host.content });

    expect(result.written).toEqual([SCENE_PATH]);
    expect(host.bytes(SCENE_PATH)).toEqual(canonical);
  });
});

describe('ED-21: правка одного значения меняет в файле только связанные строки', () => {
  it('дифф сцены после правки одного поля префаба — одна строка', async () => {
    const canonical = canonicalizeDocument(SCENE_ON_DISK);
    const host = createMemoryHost({ files: { [SCENE_PATH]: canonical } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene' });

    session.applyOperation('document.setValue', {
      document: SCENE_PATH,
      path: ['prefabs', 0, 'components', 'Locomotion', 'maxSpeed'],
      value: 5000,
    });
    await saveDocuments({ session, host: host.content });

    const lines = changedLines(decoder.decode(canonical), host.text(SCENE_PATH));
    expect(lines).toHaveLength(1);
    expect(host.text(SCENE_PATH).split('\n')[lines[0]!]).toContain('"maxSpeed": 5000');
  });
});

describe('ED-21, SER-8: порядок записей расстановки переживает сохранение', () => {
  const initialOf = (value: JsonValue): readonly JsonValue[] =>
    (value as { initial: readonly JsonValue[] }).initial;

  it('новая запись дописывается в конец, прежние остаются на своих местах', async () => {
    const canonical = canonicalizeDocument(MATCH_ON_DISK);
    const host = createMemoryHost({ files: { [MATCH_PATH]: canonical } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: MATCH_PATH,
      kind: 'match',
      lists: [['initial']],
    });

    const before = initialOf(decodeDocument(canonical));
    expect(before).toHaveLength(2);

    session.applyOperation('document.list.append', {
      document: MATCH_PATH,
      list: ['initial'],
      item: { prefab: 'Hero', overrides: { Player: { slot: 2 } } },
    });
    await saveDocuments({ session, host: host.content });

    const after = initialOf(decodeDocument(host.bytes(MATCH_PATH)));
    expect(after).toHaveLength(3);
    // Порядок нормативен: он задаёт выданные ID (SER-8, ID-2). Первые две
    // записи обязаны остаться теми же и на тех же местах.
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toEqual({ prefab: 'Hero', overrides: { Player: { slot: 2 } } });
  });

  it('правка поля записи не переставляет записи и не пересортировывает список', async () => {
    const canonical = canonicalizeDocument(MATCH_ON_DISK);
    const host = createMemoryHost({ files: { [MATCH_PATH]: canonical } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: MATCH_PATH,
      kind: 'match',
      lists: [['initial']],
    });

    // Правится ПЕРВАЯ запись — та, чья перестановка сдвинула бы ID всех
    // остальных, то есть изменила бы `worldInit` документа, который автор
    // в остальном не трогал.
    const first = session.descriptors(MATCH_PATH, ['initial'])[0]!;
    session.applyOperation('document.list.setValue', {
      document: MATCH_PATH,
      record: first,
      path: ['overrides', 'Player', 'slot'],
      value: 7,
    });
    await saveDocuments({ session, host: host.content });

    const after = initialOf(decodeDocument(host.bytes(MATCH_PATH)));
    expect(after).toEqual([
      { prefab: 'Hero', overrides: { Player: { slot: 7 } } },
      { prefab: 'Hero', overrides: { Player: { slot: 1 } } },
    ]);
  });
});

describe('ED-21: сохранение затрагивает только документы с правками', () => {
  function project(): { host: MemoryHost; session: EditorSession } {
    const host = createMemoryHost({
      files: {
        [SCENE_PATH]: canonicalizeDocument(SCENE_ON_DISK),
        [MANIFEST_PATH]: canonicalizeDocument(MANIFEST_ON_DISK),
      },
    });
    return { host, session: newSession() };
  }

  it('из двух открытых документов пишется тот, где есть правка', async () => {
    const { host, session } = project();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene' });
    await openDocumentFromHost(session, host.content, { id: MANIFEST_PATH, kind: 'manifest' });
    const manifestBefore = host.bytes(MANIFEST_PATH);

    session.applyOperation('document.setValue', {
      document: SCENE_PATH,
      path: ['capacity'],
      value: 512,
    });
    const result = await saveDocuments({ session, host: host.content });

    expect(result.written).toEqual([SCENE_PATH]);
    expect(host.writes).toEqual([SCENE_PATH]);
    expect(host.bytes(MANIFEST_PATH)).toEqual(manifestBefore);
    expect(session.dirtyDocumentIds()).toEqual([]);
  });

  it('названный к сохранению документ без правок в запись не попадает', async () => {
    const { host, session } = project();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene' });
    await openDocumentFromHost(session, host.content, { id: MANIFEST_PATH, kind: 'manifest' });

    session.applyOperation('document.setValue', { document: SCENE_PATH, path: ['capacity'], value: 512 });
    const result = await saveDocuments({
      session,
      host: host.content,
      documentIds: [SCENE_PATH, MANIFEST_PATH],
    });

    expect(result.written).toEqual([SCENE_PATH]);
    expect(result.unchanged).toEqual([MANIFEST_PATH]);
  });
});

describe('ED-21, ED-19: сохранение не оставляет на диске рассинхронизированную тройку', () => {
  const PAIRING: ScenePairing = { scene: SCENE_PATH, manifest: MANIFEST_PATH };

  async function opened(files: Readonly<Record<string, Uint8Array>>): Promise<{
    host: MemoryHost;
    session: EditorSession;
  }> {
    const host = createMemoryHost({ files });
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene', lists: [['initial']] });
    await openDocumentFromHost(session, host.content, { id: MANIFEST_PATH, kind: 'manifest' });
    return { host, session };
  }

  const SCENE = encodeDocument({
    components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
    prefabs: [{ name: 'Hero', components: { Position: { x: 0, y: 0 } } }],
    initial: [{ prefab: 'Hero' }],
  });
  const MANIFEST = encodeDocument({ entities: { Hero: { model: 'visuals/models/hero.mdx' } } });

  it('согласованный проект сохраняется без замечаний', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Hero' },
    });

    const result = await saveDocuments({ session, host: host.content, ...scenePairingSave([PAIRING]) });
    expect(result.refused).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.written).toEqual([SCENE_PATH]);
  });

  it('запись расстановки на несуществующий prefab на диск не доводится', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Ghost' },
    });

    const result = await saveDocuments({ session, host: host.content, ...scenePairingSave([PAIRING]) });

    expect(result.refused).toBe(true);
    expect(result.written).toEqual([]);
    expect(host.writes).toEqual([]);
    expect(result.issues).toContainEqual({
      ruleId: 'save.pairing.sceneManifest',
      messageKey: 'save.issue.placementWithoutPrefab',
      documentId: SCENE_PATH,
      path: ['initial', 1],
      detail: { prefab: 'Ghost' },
      blocking: true,
    });
  });

  it('новый prefab без записи манифеста — рассинхронизация пары, вносимая этим сохранением', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.setValue', {
      document: SCENE_PATH,
      path: ['prefabs', 1],
      value: { name: 'Fireball', components: { Position: { x: 0, y: 0 } } },
    });

    const result = await saveDocuments({ session, host: host.content, ...scenePairingSave([PAIRING]) });

    expect(result.refused).toBe(true);
    expect(result.issues).toContainEqual({
      ruleId: 'save.pairing.sceneManifest',
      messageKey: 'save.issue.prefabWithoutManifestRecord',
      documentId: SCENE_PATH,
      detail: { prefab: 'Fireball', manifest: MANIFEST_PATH },
      blocking: true,
    });
  });

  it('обе половины пары, заведённые одной правкой, сохраняются вместе', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.setValue', {
      document: SCENE_PATH,
      path: ['prefabs', 1],
      value: { name: 'Fireball', components: { Position: { x: 0, y: 0 } } },
    });
    session.applyOperation('document.setValue', {
      document: MANIFEST_PATH,
      path: ['entities', 'Fireball'],
      value: { model: 'visuals/models/fireball.mdx' },
    });

    const result = await saveDocuments({ session, host: host.content, ...scenePairingSave([PAIRING]) });
    expect(result.refused).toBe(false);
    expect([...result.written].sort()).toEqual([MANIFEST_PATH, SCENE_PATH].sort());
  });

  it('расхождение, уже лежащее на диске, сохранять не мешает — это дело валидации (ED-8)', async () => {
    // Prefab без записи манифеста — легальное состояние рантайма (ASSET-6:
    // рендер показывает заглушку). Отказать в сохранении из-за него значило бы
    // ввести правило строже нормы.
    const scene = encodeDocument({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      prefabs: [
        { name: 'Hero', components: { Position: { x: 0, y: 0 } } },
        { name: 'Fireball', components: { Position: { x: 0, y: 0 } } },
      ],
      initial: [{ prefab: 'Hero' }],
    });
    const { host, session } = await opened({ [SCENE_PATH]: scene, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Hero' },
    });

    const result = await saveDocuments({ session, host: host.content, ...scenePairingSave([PAIRING]) });

    expect(result.refused).toBe(false);
    expect(result.written).toEqual([SCENE_PATH]);
    expect(result.issues).toEqual([
      {
        ruleId: 'save.pairing.sceneManifest',
        messageKey: 'save.issue.prefabWithoutManifestRecord',
        documentId: SCENE_PATH,
        detail: { prefab: 'Fireball', manifest: MANIFEST_PATH },
        blocking: false,
      },
    ]);
  });

  it('член тройки с правками нельзя оставить несохранённым — включая парный presentation-документ', async () => {
    const PRESENTATION = 'scenes/duel.presentation.json';
    const host = createMemoryHost({
      files: { [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST, [PRESENTATION]: encodeDocument({}) },
    });
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: SCENE_PATH, kind: 'scene', lists: [['initial']] });
    await openDocumentFromHost(session, host.content, { id: MANIFEST_PATH, kind: 'manifest' });
    await openDocumentFromHost(session, host.content, { id: PRESENTATION, kind: 'presentation' });

    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Hero' },
    });
    // Формат парного документа не нормирован (`presentation-scene-layer` —
    // стаб), поэтому о его содержимом здесь не утверждается ничего: проверяется
    // единственное, что от формата не зависит, — правки членов тройки уходят на
    // диск одной записью.
    session.applyOperation('document.setValue', { document: PRESENTATION, path: ['decorations'], value: [] });

    const pairing: ScenePairing = { ...PAIRING, presentation: PRESENTATION };
    const partial = await saveDocuments({
      session,
      host: host.content,
      documentIds: [SCENE_PATH],
      ...scenePairingSave([pairing]),
    });

    expect(partial.refused).toBe(true);
    expect(host.writes).toEqual([]);
    expect(partial.issues).toContainEqual({
      ruleId: 'save.group.writeTogether',
      messageKey: 'save.issue.groupMemberLeftUnsaved',
      documentId: PRESENTATION,
      detail: { group: SCENE_PATH },
      blocking: true,
    });

    const full = await saveDocuments({ session, host: host.content, ...scenePairingSave([pairing]) });
    expect(full.refused).toBe(false);
    expect([...full.written].sort()).toEqual([PRESENTATION, SCENE_PATH].sort());
  });
});
