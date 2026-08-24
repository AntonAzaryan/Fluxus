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
import {
  createEditorSession,
  getAtPath,
  isJsonArray,
  type EditorSession,
  type OperationTransaction,
} from '../src/document/index.js';
import { createOperationRegistry, registerBuiltinOperations } from '../src/operations/index.js';
import { createMemoryHost, type ContentTreeHost, type MemoryHost } from '../src/host/index.js';
import {
  canonicalizeDocument,
  decodeDocument,
  encodeDocument,
  isCanonicalDocument,
  openDocumentFromHost,
  pairingGroups,
  saveDocuments,
  GROUP_WRITE_RULE_ID,
  type ScenePairing,
} from '../src/project/index.js';
import { ContributionRegistry } from '../src/registry/index.js';
import {
  createValidator,
  crossDocumentRules,
  reasonKey,
  registerValidationRules,
  ruleDescriptionKey,
  PLACEMENT_PREFAB_RULE,
  VISUAL_FOR_PREFAB_RULE,
  type ValidationRule,
} from '../src/validation/index.js';
import type { JsonValue } from '../src/document/json.js';

const decoder = new TextDecoder();

function contentFile(relative: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../content/${relative}`, import.meta.url))));
}

const SCENE_PATH = 'scenes/duel.scene.json';
const MATCH_PATH = 'matches/duel.match.json';
const MANIFEST_PATH = 'visuals/manifest.json';
/** Парный presentation-документ сцены (`presentation-scene` PRES-1). */
const PRESENTATION_PATH = 'scenes/duel.presentation.json';

const SCENE_ON_DISK = contentFile('scenes/duel.scene.json');
const MATCH_ON_DISK = contentFile('matches/duel.match.json');
const MANIFEST_ON_DISK = contentFile('visuals/manifest.json');
const PRESENTATION_ON_DISK = contentFile('scenes/duel.presentation.json');

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

/**
 * Третий член тройки ED-19 — парный presentation-документ (PRES-1). Свойство у
 * него то же самое, и проверяется оно на настоящем документе дерева контента:
 * канонический вид формата обязан быть точкой покоя, а «открыл — сохранил» —
 * давать байт-в-байт тот же файл. Квантование (PRES-3) при этом касается
 * ЗАПИСЫВАЕМОГО автором значения, а не прочитанного, и файл, написанный руками
 * с большей точностью, разрядов не теряет.
 */
describe('ED-21, PRES-3: парный документ переживает «открыл — сохранил»', () => {
  it('документ дерева контента остаётся на диске побайтово прежним', async () => {
    const host = createMemoryHost({ files: { [PRESENTATION_PATH]: PRESENTATION_ON_DISK } });
    const before = host.bytes(PRESENTATION_PATH);
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: PRESENTATION_PATH,
      kind: 'presentation',
      lists: [['decorations']],
    });

    const result = await saveDocuments({ session, host: host.content });

    expect(result).toMatchObject({ refused: false, written: [] });
    expect(host.writes).toEqual([]);
    expect(host.bytes(PRESENTATION_PATH)).toEqual(before);
  });

  it('канонический вид — точка покоя, и приведение к нему ничего не теряет', () => {
    const canonical = canonicalizeDocument(PRESENTATION_ON_DISK);
    expect(isCanonicalDocument(canonical)).toBe(true);
    expect(canonicalizeDocument(canonical)).toEqual(canonical);
    expect(decodeDocument(canonical)).toEqual(decodeDocument(PRESENTATION_ON_DISK));
  });

  it('правка и возврат значения дают байт-в-байт тот же файл', async () => {
    const canonical = canonicalizeDocument(PRESENTATION_ON_DISK);
    const host = createMemoryHost({ files: { [PRESENTATION_PATH]: canonical } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: PRESENTATION_PATH,
      kind: 'presentation',
      lists: [['decorations']],
    });

    // Запись адресуется дескриптором, а не путём (ED-29) — так же, как запись
    // расстановки: список `decorations` отслеживается сессией.
    const record = session.descriptors(PRESENTATION_PATH, ['decorations'])[0]!;
    const edit = (value: number): void => {
      session.applyOperation('document.list.setValue', {
        document: PRESENTATION_PATH,
        record,
        path: ['x'],
        value,
      });
    };
    // Возвращаемое значение читается из документа, а не пишется числом: тест
    // пиннится на настоящем контенте, а координаты декораций — дело дизайнера.
    const original = (
      decodeDocument(canonical) as { decorations: readonly { x: number }[] }
    ).decorations[0]!.x;
    edit(original + 1.625);
    edit(original);

    const result = await saveDocuments({ session, host: host.content });

    expect(result.written).toEqual([PRESENTATION_PATH]);
    expect(host.bytes(PRESENTATION_PATH)).toEqual(canonical);
  });

  it('запись, сделанная руками с большей точностью, разрядов не теряет', async () => {
    // Квантуется записываемое, а не прочитанное (PRES-3): сохранение чужой
    // записи не касается, и точность у неё остаётся авторская.
    const handwritten = encodeDocument({
      decorations: [
        { visual: 'Statue', x: 1.23456789, y: -0.000000001 },
        { visual: 'Statue', x: 2, y: 2 },
      ],
    });
    const host = createMemoryHost({ files: { [PRESENTATION_PATH]: handwritten } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: PRESENTATION_PATH,
      kind: 'presentation',
      lists: [['decorations']],
    });

    session.applyOperation('document.list.setValue', {
      document: PRESENTATION_PATH,
      record: session.descriptors(PRESENTATION_PATH, ['decorations'])[1]!,
      path: ['x'],
      value: 5,
    });
    await saveDocuments({ session, host: host.content });

    const saved = decodeDocument(host.bytes(PRESENTATION_PATH)) as {
      decorations: readonly Record<string, JsonValue>[];
    };
    expect(saved.decorations[0]).toEqual({ visual: 'Statue', x: 1.23456789, y: -0.000000001 });
    // Дифф правки — одна строка: ради читаемости диффа квантование и заведено.
    const lines = changedLines(decoder.decode(handwritten), host.text(PRESENTATION_PATH));
    expect(lines).toHaveLength(1);
  });

  it('walkable записи переживает «открыл — сохранил» как есть: true, явный false, отсутствие (PRES-2)', async () => {
    // Неразличимость false и отсутствия (PRES-2) — правило ЗАПИСЫВАЮЩЕЙ
    // операции (false не пишется), а не сохранения: канонический вид значение
    // сохраняет как есть (ED-21), и рукописный `walkable: false` не
    // выбрасывается и не дописывается — как и у остальных необязательных полей.
    const handwritten = encodeDocument({
      decorations: [
        { visual: 'Bridge', x: 1, y: 2, walkable: true },
        { visual: 'Bridge', x: 3, y: 4, walkable: false },
        { visual: 'Bridge', x: 5, y: 6 },
      ],
    });
    const host = createMemoryHost({ files: { [PRESENTATION_PATH]: handwritten } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: PRESENTATION_PATH,
      kind: 'presentation',
      lists: [['decorations']],
    });

    // «Открыл — сохранил без правок»: ни байта диффа.
    const untouched = await saveDocuments({ session, host: host.content });
    expect(untouched).toMatchObject({ refused: false, written: [] });
    expect(host.bytes(PRESENTATION_PATH)).toEqual(handwritten);

    // Правка другой записи не трогает walkable-поля соседей (ED-21).
    session.applyOperation('document.list.setValue', {
      document: PRESENTATION_PATH,
      record: session.descriptors(PRESENTATION_PATH, ['decorations'])[2]!,
      path: ['x'],
      value: 7,
    });
    await saveDocuments({ session, host: host.content });

    const saved = decodeDocument(host.bytes(PRESENTATION_PATH)) as {
      decorations: readonly Record<string, JsonValue>[];
    };
    expect(saved.decorations[0]).toEqual({ visual: 'Bridge', x: 1, y: 2, walkable: true });
    expect(saved.decorations[1]).toEqual({ visual: 'Bridge', x: 3, y: 4, walkable: false });
    expect(saved.decorations[2]).toEqual({ visual: 'Bridge', x: 7, y: 6 });
  });

  it('секция lighting переживает «открыл — сохранил» и правку соседей (PRES-2)', async () => {
    // Секция авторится руками в JSON, и сохранение обязано оставить её ровно
    // такой, какой она написана: ни порядка ключей, ни состава подсекций
    // канонический вид не трогает (ED-21). Правило то же, что у секции `fog`, —
    // здесь оно закрепляется на секции, ради которой заведён свет.
    const handwritten = encodeDocument({
      decorations: [{ visual: 'Statue', x: 1, y: 2 }],
      lighting: {
        ambient: { color: '#ffffff', intensity: 0.65 },
        directional: { intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
        shadows: { mode: 'hybrid', mapSize: 1024, staticShare: 0.5 },
      },
    });
    const host = createMemoryHost({ files: { [PRESENTATION_PATH]: handwritten } });
    const session = newSession();
    await openDocumentFromHost(session, host.content, {
      id: PRESENTATION_PATH,
      kind: 'presentation',
      lists: [['decorations']],
    });

    const untouched = await saveDocuments({ session, host: host.content });
    expect(untouched).toMatchObject({ refused: false, written: [] });
    expect(host.bytes(PRESENTATION_PATH)).toEqual(handwritten);

    // Правка декорации секции не касается: дифф — одна строка, а секция
    // остаётся байт-в-байт, включая порядок ключей внутри подсекций.
    session.applyOperation('document.list.setValue', {
      document: PRESENTATION_PATH,
      record: session.descriptors(PRESENTATION_PATH, ['decorations'])[0]!,
      path: ['x'],
      value: 9,
    });
    await saveDocuments({ session, host: host.content });

    const before = decoder.decode(handwritten);
    const after = host.text(PRESENTATION_PATH);
    expect(changedLines(before, after)).toHaveLength(1);
    const saved = decodeDocument(host.bytes(PRESENTATION_PATH)) as { lighting: JsonValue };
    expect(saved.lighting).toEqual({
      ambient: { color: '#ffffff', intensity: 0.65 },
      directional: { intensity: 1.7, direction: { x: 8, y: -12, z: 18 } },
      shadows: { mode: 'hybrid', mapSize: 1024, staticShare: 0.5 },
    });
    // Порядок ключей секции — авторский: сортировка дала бы дифф на весь файл.
    expect(after.indexOf('"ambient"')).toBeLessThan(after.indexOf('"directional"'));
    expect(after.indexOf('"directional"')).toBeLessThan(after.indexOf('"shadows"'));
  });

  it('парный документ — член группы записи тройки (ED-19)', () => {
    const [group] = pairingGroups([
      { scene: SCENE_PATH, manifest: MANIFEST_PATH, presentation: PRESENTATION_PATH },
    ]);
    expect(group?.members).toEqual([SCENE_PATH, MANIFEST_PATH, PRESENTATION_PATH]);
    // Сцены без декораций пара из двух: создавать файл ради пустого слоя
    // нельзя, и отсутствие члена в группе означает ровно это (PRES-1).
    const [pairOnly] = pairingGroups([{ scene: SCENE_PATH, manifest: MANIFEST_PATH }]);
    expect(pairOnly?.members).toEqual([SCENE_PATH, MANIFEST_PATH]);
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
    const before = initialOf(decodeDocument(canonical));
    const first = session.descriptors(MATCH_PATH, ['initial'])[0]!;
    session.applyOperation('document.list.setValue', {
      document: MATCH_PATH,
      record: first,
      path: ['overrides', 'Player', 'slot'],
      value: 7,
    });
    await saveDocuments({ session, host: host.content });

    // Ожидание строится из прочитанного документа, а не из переписанного сюда
    // контента: остальные поля записей — дело дизайнера, а тест про порядок.
    const patched = before[0] as { overrides?: Record<string, JsonValue> };
    const after = initialOf(decodeDocument(host.bytes(MATCH_PATH)));
    expect(after).toEqual([
      { ...patched, overrides: { ...patched.overrides, Player: { slot: 7 } } },
      before[1],
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
      value: 640,
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

    session.applyOperation('document.setValue', { document: SCENE_PATH, path: ['capacity'], value: 640 });
    const result = await saveDocuments({
      session,
      host: host.content,
      documentIds: [SCENE_PATH, MANIFEST_PATH],
    });

    expect(result.written).toEqual([SCENE_PATH]);
    expect(result.unchanged).toEqual([MANIFEST_PATH]);
  });
});

/**
 * Согласованность тройки проверяют те же правила-вклады, что подсвечивают её
 * при правке (ED-8, ED-19, ED-25): сохранение получает реестр правил, а второго
 * набора своих у него нет. Отсюда и форма замечаний — `ValidationIssue`, тот же
 * структурный результат, что у валидации реального времени (ED-30).
 */
describe('ED-21, ED-19: сохранение не оставляет на диске рассинхронизированную тройку', () => {
  const PAIRING: ScenePairing = { scene: SCENE_PATH, manifest: MANIFEST_PATH };

  /** Реестр правил редактора — тот же, из которого работает валидатор (ED-25). */
  function editorRules(...extra: readonly ValidationRule[]): ContributionRegistry<ValidationRule> {
    const registry = new ContributionRegistry<ValidationRule>({ kind: 'rule' });
    registerValidationRules(registry, [...crossDocumentRules(), ...extra]);
    return registry;
  }

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

    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules: editorRules(),
    });
    expect(result.refused).toBe(false);
    expect(result.report.issues).toEqual([]);
    expect(result.blocking).toEqual([]);
    expect(result.written).toEqual([SCENE_PATH]);
  });

  it('запись расстановки на несуществующий prefab на диск не доводится', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Ghost' },
    });

    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules: editorRules(),
    });

    expect(result.refused).toBe(true);
    expect(result.written).toEqual([]);
    expect(host.writes).toEqual([]);
    // Форма замечания — та же находка, что у валидации: правило, путь,
    // полученное значение, ожидание и ключ причины (ED-30).
    expect(result.blocking).toEqual([
      {
        ruleId: PLACEMENT_PREFAB_RULE,
        severity: 'error',
        documentId: SCENE_PATH,
        path: ['initial', 1, 'prefab'],
        received: 'Ghost',
        expected: {
          kind: 'reference',
          targets: [{ documentId: SCENE_PATH, path: ['prefabs'] }],
          known: ['Arena', 'Hero', 'Terrain'],
        },
        reasonKey: reasonKey(PLACEMENT_PREFAB_RULE, 'missingPrefab'),
        reasonParams: { name: 'Ghost' },
      },
    ]);
  });

  it('новый prefab без записи манифеста — рассинхронизация пары, вносимая этим сохранением', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.setValue', {
      document: SCENE_PATH,
      path: ['prefabs', 1],
      value: { name: 'Fireball', components: { Position: { x: 0, y: 0 } } },
    });

    const rules = editorRules();
    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules,
    });

    expect(result.refused).toBe(true);
    expect(result.blocking.map((issue) => issue.ruleId)).toEqual([VISUAL_FOR_PREFAB_RULE]);
    expect(result.blocking[0]).toMatchObject({
      documentId: SCENE_PATH,
      path: ['prefabs', 1, 'name'],
      received: 'Fireball',
      reasonKey: reasonKey(VISUAL_FOR_PREFAB_RULE, 'missingVisual'),
      reasonParams: { name: 'Fireball' },
    });

    // Одно описание нарушения на редактор: то, чем сохранение отвергло запись,
    // и то, чем валидация подсвечивает место при правке, — одно значение.
    const live = createValidator({ rules }).run(session);
    expect(result.blocking).toEqual([...live.forDocument(SCENE_PATH)]);
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

    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules: editorRules(),
    });
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

    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules: editorRules(),
    });

    expect(result.refused).toBe(false);
    expect(result.written).toEqual([SCENE_PATH]);
    expect(result.blocking).toEqual([]);
    // Найдено оно при этом не молча: отчёт называет его наравне с остальным.
    expect(result.report.issues.map((issue) => issue.ruleId)).toEqual([VISUAL_FOR_PREFAB_RULE]);
    expect(result.report.severityOf(SCENE_PATH)).toBe('error');
  });

  it('внесённое предупреждение записи не отвергает: отказ — свойство важности, а не факта правки', async () => {
    /** Предупреждение, которого до правки не было: записей расстановки станет две. */
    const crowded: ValidationRule = {
      id: 'test.crowded',
      descriptionKey: ruleDescriptionKey('test.crowded'),
      reasonCodes: ['crowded'],
      appliesTo: ['scene'],
      severity: 'warning',
      check(run) {
        const initial = getAtPath(run.document.value, ['initial']);
        if (!isJsonArray(initial) || initial.length < 2) return;
        run.report({ path: ['initial'], expected: { kind: 'range', max: 1 }, code: 'crowded' });
      },
    };
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Hero' },
    });

    const result = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([PAIRING]),
      rules: editorRules(crowded),
    });

    expect(result.refused).toBe(false);
    expect(result.written).toEqual([SCENE_PATH]);
    expect(result.blocking).toEqual([]);
    expect(result.report.severityOf(SCENE_PATH, ['initial'])).toBe('warning');
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
      groups: pairingGroups([pairing]),
      rules: editorRules(),
    });

    expect(partial.refused).toBe(true);
    expect(host.writes).toEqual([]);
    // Правило записи судит не дерево, а само сохранение — и говорит о нём в том
    // же словаре: ожидание «эти документы уходят одной записью».
    expect(partial.blocking).toEqual([
      {
        ruleId: GROUP_WRITE_RULE_ID,
        severity: 'error',
        documentId: PRESENTATION,
        path: [],
        received: { decorations: [] },
        expected: { kind: 'together', members: [SCENE_PATH, MANIFEST_PATH, PRESENTATION] },
        reasonKey: reasonKey(GROUP_WRITE_RULE_ID, 'memberLeftUnsaved'),
        reasonParams: { group: SCENE_PATH },
      },
    ]);

    const full = await saveDocuments({
      session,
      host: host.content,
      groups: pairingGroups([pairing]),
      rules: editorRules(),
    });
    expect(full.refused).toBe(false);
    expect([...full.written].sort()).toEqual([PRESENTATION, SCENE_PATH].sort());
  });

  it('сохранение не сбивает кэш валидатора: прогон без правок по-прежнему не исполняет ничего', async () => {
    const { host, session } = await opened({ [SCENE_PATH]: SCENE, [MANIFEST_PATH]: MANIFEST });
    session.applyOperation('document.list.append', {
      document: SCENE_PATH,
      list: ['initial'],
      item: { prefab: 'Hero' },
    });

    const rules = editorRules();
    const validator = createValidator({ rules });
    validator.run(session);
    validator.run(session);
    expect(validator.lastRun.executed).toBe(0);

    // У сохранения свой прогон по состоянию диска: подмешаться в кэш редактора
    // он не должен, иначе валидация реального времени пересчитывала бы всё
    // после каждой записи (ED-8).
    await saveDocuments({ session, host: host.content, groups: pairingGroups([PAIRING]), rules });

    validator.run(session);
    // Четыре пары «правило × документ»: сцена держит два междокументных
    // правила, манифест — два своих (пара ED-19 и имя состояния CAM-6).
    expect(validator.lastRun).toEqual({ executed: 0, reused: 4 });
  });
});

/**
 * Запись асинхронна (у веб-среды она сетевая), а сессия между `await`
 * продолжает принимать правки. ED-21 при этом требует, чтобы на диск ушло ровно
 * то состояние, которое прошло блокирующую проверку, — поэтому сохранение
 * снимает значения до первого `await` и пишет снимок, а не «текущее на момент
 * записи».
 */
describe('ED-21, ED-18: сохранение не гонится с параллельной правкой', () => {
  const A = 'docs/a.json';
  const B = 'docs/b.json';

  async function opened(): Promise<{ host: MemoryHost; session: EditorSession }> {
    const host = createMemoryHost({
      files: { [A]: encodeDocument({ title: 'a' }), [B]: encodeDocument({ title: 'b' }) },
    });
    const session = newSession();
    await openDocumentFromHost(session, host.content, { id: A, kind: 'any' });
    await openDocumentFromHost(session, host.content, { id: B, kind: 'any' });
    session.applyOperation('document.setValue', { document: A, path: ['title'], value: 'a2' });
    session.applyOperation('document.setValue', { document: B, path: ['title'], value: 'b2' });
    return { host, session };
  }

  /** Хост, у которого запись первого документа приносит событие в сессию. */
  function hostActingOnWrite(host: MemoryHost, during: () => void): ContentTreeHost {
    let acted = false;
    return {
      ...host.content,
      write: async (path, bytes) => {
        if (!acted) {
          acted = true;
          during();
        }
        await host.content.write(path, bytes);
      },
    };
  }

  it('правка, пришедшая во время записи, на диск не попадает и сохранённой не числится', async () => {
    const { host, session } = await opened();
    const content = hostActingOnWrite(host, () => {
      // Правка второго документа приходит, пока сохранение ждёт записи
      // первого: проверка её не видела, и записать её значило бы записать
      // непроверенное (ED-21).
      session.applyOperation('document.setValue', { document: B, path: ['title'], value: 'внезапная' });
    });

    const result = await saveDocuments({ session, host: content });

    expect(result.refused).toBe(false);
    expect(result.written).toEqual([A, B]);
    // На диске — проверенный снимок, а не правка, которой проверка не видела.
    expect(decodeDocument(host.bytes(B))).toEqual({ title: 'b2' });
    // Сама правка не потеряна и сохранённой не объявлена: её очередь —
    // следующее сохранение.
    expect(session.documentValue(B)).toEqual({ title: 'внезапная' });
    expect(session.dirtyDocumentIds()).toEqual([B]);

    const again = await saveDocuments({ session, host: host.content });
    expect(again.written).toEqual([B]);
    expect(decodeDocument(host.bytes(B))).toEqual({ title: 'внезапная' });
    expect(session.dirtyDocumentIds()).toEqual([]);
  });

  it('взаимодействие, открывшееся во время записи, не роняет сохранение и не кладёт на диск провизорного', async () => {
    const { host, session } = await opened();
    let stroke: OperationTransaction | undefined;
    const content = hostActingOnWrite(host, () => {
      // Мазок открывается, пока сохранение ждёт записи первого документа:
      // промежуточное состояние мазка на диск не попадает (ED-18).
      stroke = session.beginOperation('document.setValue', { document: B, path: ['title'], value: 'мазок' });
    });

    const result = await saveDocuments({ session, host: content });

    // Группа записана целиком, а не оборвана отказом посреди цикла (ED-19).
    expect(result.refused).toBe(false);
    expect(result.written).toEqual([A, B]);
    expect(decodeDocument(host.bytes(A))).toEqual({ title: 'a2' });
    expect(decodeDocument(host.bytes(B))).toEqual({ title: 'b2' });

    // Мазок жив: сохранение его не трогало, и отмена возвращает документ.
    expect(session.pending).toBe(true);
    stroke!.cancel();
    expect(session.documentValue(B)).toEqual({ title: 'b2' });
    // Сохранённым при открытом мазке не объявлялся никто (`markSaved` посреди
    // взаимодействия запрещён сессией); порядок наводит следующее сохранение.
    expect(session.dirtyDocumentIds()).toEqual([A, B]);
    const again = await saveDocuments({ session, host: host.content });
    expect(again.written).toEqual([A, B]);
    expect(session.dirtyDocumentIds()).toEqual([]);
  });

  it('сохранение посреди незакрытого взаимодействия отказывает до первой записи', async () => {
    const { host, session } = await opened();
    const stroke = session.beginOperation('document.setValue', { document: A, path: ['title'], value: 'мазок' });

    await expect(saveDocuments({ session, host: host.content })).rejects.toThrow(
      /незакрытого взаимодействия/,
    );
    // Не записано ничего: отказ пришёл раньше, чем снимок провизорных значений.
    expect(host.writes).toEqual([]);
    stroke.cancel();
  });
});
