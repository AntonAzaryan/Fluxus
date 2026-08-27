#!/usr/bin/env node
/**
 * spec-graph — stateless-навигация и линт по графу спек `openspec/specs/`.
 *
 * Источник правды — markdown в git: никакого кэша, индекса или БД, каждый
 * вызов парсит дерево заново (~1 МБ, миллисекунды). Дельта-спеки из
 * `openspec/changes/` инструмент не видит: пока change не заархивирован,
 * граф показывает состояние «до».
 *
 * Формат заголовков (`### Requirement: <ID> <заголовок>`) принадлежит
 * OpenSpec и прибит `openspec validate --specs --strict`; смену формата
 * при апгрейде CLI ловит тест specGraph.test.ts в integration-ts.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SPECS_DIR = join(REPO_ROOT, 'openspec', 'specs');
export const DEFAULT_LAYERS_PATH = join(REPO_ROOT, 'scripts', 'spec-graph.layers.json');
// Все кодовые деревья репозитория: цитата, уехавшая из корня, молча выпадает
// и из `code <ID>`, и из линта dangling-code — корни держатся полными.
export const DEFAULT_CODE_ROOTS = ['engine', 'editor', 'game', 'tools', 'desktop', 'scripts'].map(
  (d) => join(REPO_ROOT, d),
);

const ID_RE = /\b([A-Z]{2,6}-[0-9]+)\b/g;
const HEADER_RE = /^### Requirement:\s+([A-Z]{2,6}-[0-9]+)\s*(.*)$/;
/** Заявленная атрибуция: имя capability в бэктиках непосредственно перед ID. */
const ATTR_RE = /`([a-z][a-z0-9-]*)`\s+([A-Z]{2,6}-[0-9]+)\b/g;
const MODALITY_RE = /\b(SHALL|MUST)\b/;

/**
 * Разбирает дерево спек в модель графа.
 *
 * Требование — узел; упоминание чужого определённого ID в теле секции — ребро
 * «цитирующий → цитируемый». Упоминание собственного ID ребром не считается.
 * Упоминание ID, не определённого нигде, — не ребро, а находка `dangling`.
 */
export function buildModel(specsDir = DEFAULT_SPECS_DIR) {
  const capabilities = new Map(); // name -> {name, file, title, purpose, purposeLine, requirementIds: []}
  const requirements = new Map(); // id -> {id, title, capability, file, line, body}
  const duplicates = []; // {id, file, line, firstFile, firstLine}
  const mentions = []; // {fromId, toId, declaredCap, file, line} — все упоминания ID, включая неопределённые

  for (const entry of readdirSync(specsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(specsDir, entry.name, 'spec.md');
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');

    const cap = {
      name: entry.name,
      file,
      title: (lines[0] ?? '').replace(/^#\s*/, ''),
      purpose: '',
      requirementIds: [],
    };
    capabilities.set(entry.name, cap);

    let current = null; // текущее требование
    let inPurpose = false;
    const purposeLines = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const header = line.match(HEADER_RE);
      if (header) {
        const [, id, title] = header;
        if (requirements.has(id)) {
          const first = requirements.get(id);
          duplicates.push({ id, file, line: i + 1, firstFile: first.file, firstLine: first.line });
          current = null; // тело дубля не приписывается первому определению
          continue;
        }
        current = { id, title: title ?? '', capability: entry.name, file, line: i + 1, body: '' };
        requirements.set(id, current);
        cap.requirementIds.push(id);
        inPurpose = false;
        continue;
      }
      if (/^## /.test(line) || /^### /.test(line)) {
        current = null;
        inPurpose = /^## Purpose\b/.test(line);
        continue;
      }
      if (inPurpose) purposeLines.push(line);
      if (current) current.body += line + '\n';
    }
    cap.purpose = purposeLines.join('\n').trim();
  }

  // Второй проход — упоминания: словарь определений уже полон.
  for (const req of requirements.values()) {
    const bodyLines = req.body.split('\n');
    for (let j = 0; j < bodyLines.length; j++) {
      const text = bodyLines[j] ?? '';
      // Атрибуция привязывается к вхождению ID по его позиции в строке.
      const attrs = new Map(); // позиция начала ID -> заявленное имя capability
      for (const m of text.matchAll(ATTR_RE)) {
        const [full, name, id] = m;
        if (capabilities.has(name)) attrs.set(m.index + full.length - id.length, name);
      }
      for (const m of text.matchAll(ID_RE)) {
        const id = m[1];
        if (id === req.id) continue;
        mentions.push({
          fromId: req.id,
          toId: id,
          declaredCap: attrs.get(m.index) ?? null,
          file: req.file,
          line: req.line + 1 + j,
        });
      }
    }
  }

  const edges = mentions.filter((m) => requirements.has(m.toId));
  const dangling = mentions.filter((m) => !requirements.has(m.toId));

  // Агрегация до capability-уровня.
  const capEdges = new Map(); // "from->to" -> {from, to, weight, refs: Set<"fromId->toId">}
  for (const e of edges) {
    const from = requirements.get(e.fromId).capability;
    const to = requirements.get(e.toId).capability;
    if (from === to) continue;
    const key = `${from}->${to}`;
    if (!capEdges.has(key)) capEdges.set(key, { from, to, weight: 0, refs: new Set() });
    const ce = capEdges.get(key);
    ce.weight += 1;
    ce.refs.add(`${e.fromId}->${e.toId}`);
  }

  return { specsDir, capabilities, requirements, duplicates, mentions, edges, dangling, capEdges };
}

export function loadLayers(layersPath = DEFAULT_LAYERS_PATH) {
  return JSON.parse(readFileSync(layersPath, 'utf8'));
}

// Расширения, в которых цитируются ID (конвенция репы: комментарии кода,
// имена тестов, описания в сгенерированных схемах). Python — ради add-on'а.
const CODE_EXTS = new Set(['.ts', '.mts', '.mjs', '.js', '.py', '.json']);
// node_modules/dist — чужое; golden — bitwise-эталоны, не код.
const CODE_SKIP_DIRS = new Set(['node_modules', 'dist', 'golden', '.git']);

/**
 * Категория файла в индексе кода: `generated` — сгенерированные схемы
 * (каталог schemas/, правится только через npm run schemas), `test` —
 * каталоги test(s)/ и файлы *.test.*, остальное — `src`.
 * Цитата ID в коде — это «где требование упоминается», НЕ «где реализовано»:
 * отсутствие цитаты не означает отсутствия реализации.
 */
function categorize(file) {
  const parts = file.split(sep);
  if (parts.includes('schemas')) return 'generated';
  if (parts.includes('test') || parts.includes('tests') || /\.test\.[a-z]+$/.test(file)) return 'test';
  return 'src';
}

/**
 * Индекс кода: все вхождения паттерна ID в кодовых деревьях. Stateless, как
 * и граф спек — каждый вызов сканирует дерево заново (сотни файлов,
 * миллисекунды). Известность префикса и определённость ID здесь не
 * проверяются — это дело lint().
 */
export function buildCodeIndex(roots = DEFAULT_CODE_ROOTS) {
  const mentions = []; // {id, file, line, category}
  const byId = new Map(); // id -> mentions[]
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!CODE_SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!CODE_EXTS.has(extname(entry.name))) continue;
      const file = join(dir, entry.name);
      const lines = readFileSync(file, 'utf8').split('\n');
      const category = categorize(file);
      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(ID_RE)) {
          const mention = { id: m[1], file, line: i + 1, category };
          mentions.push(mention);
          if (!byId.has(m[1])) byId.set(m[1], []);
          byId.get(m[1]).push(mention);
        }
      }
    }
  };
  for (const root of roots) if (existsSync(root)) walk(root);
  return { roots, mentions, byId };
}

/**
 * Линт-инварианты графа. Возвращает находки; пустой список — дерево зелёное.
 * Классы: dangling, duplicate-id, attribution-mismatch, missing-modality,
 * unmapped-capability, content-boundary; с переданным индексом кода — ещё
 * dangling-code (код цитирует ID, не определённый ни в одной спеке).
 *
 * Направление ссылок между слоями — НЕ инвариант: на реальном дереве ссылка
 * «вверх» — принятая конвенция прозы (determinism-core перечисляет, что
 * детерминировано, ссылаясь на sim/net; ECS-3 называет потребителей типов).
 * Слои и рёбра «вверх» отдаются диагностикой в `metrics()`. Единственное
 * направление-инвариант — граница механизма и политики: спека движка
 * MUST NOT ссылаться на game-content; capability слоя editor-content
 * (редактор и форматы контент-документов) — сама сторона политики, ей можно.
 * Принятое ребро из layers.exceptions (from → game-content, с обоснованием)
 * снимает гейт для своей пары — тем же списком, каким метрики принимают
 * рёбра «вверх».
 */
export function lint(model, layers, codeIndex = null) {
  const findings = [];
  const { requirements, capabilities, duplicates, dangling, capEdges } = model;

  for (const d of duplicates) {
    findings.push({
      rule: 'duplicate-id',
      where: `${d.file}:${d.line}`,
      message: `${d.id} уже определён в ${d.firstFile}:${d.firstLine}`,
    });
  }

  // Висячей считается ссылка с ИЗВЕСТНЫМ префиксом на неопределённый номер
  // (опечатка в номере). Незнакомый префикс — не ссылка на требование вовсе
  // («UTF-8» в прозе матчится паттерном ID, но требованием не является).
  const knownPrefixes = new Set([...requirements.keys()].map((id) => id.split('-')[0]));
  for (const m of dangling) {
    if (!knownPrefixes.has(m.toId.split('-')[0])) continue;
    findings.push({
      rule: 'dangling',
      where: `${m.file}:${m.line}`,
      message: `${m.fromId} ссылается на ${m.toId}, который нигде не определён`,
    });
  }

  // Та же логика для кода: цитата с известным префиксом, но без определения —
  // требование удалили/переименовали, а код не догнал.
  if (codeIndex) {
    for (const m of codeIndex.mentions) {
      if (requirements.has(m.id)) continue;
      if (!knownPrefixes.has(m.id.split('-')[0])) continue;
      findings.push({
        rule: 'dangling-code',
        where: `${m.file}:${m.line}`,
        message: `код цитирует ${m.id}, который не определён ни в одной спеке`,
      });
    }
  }

  for (const m of model.edges) {
    if (!m.declaredCap) continue;
    const actual = requirements.get(m.toId).capability;
    if (m.declaredCap !== actual) {
      findings.push({
        rule: 'attribution-mismatch',
        where: `${m.file}:${m.line}`,
        message: `${m.fromId}: ссылка на ${m.toId} названа \`${m.declaredCap}\`, а определён он в \`${actual}\``,
      });
    }
  }

  for (const req of requirements.values()) {
    if (!MODALITY_RE.test(req.body)) {
      findings.push({
        rule: 'missing-modality',
        where: `${req.file}:${req.line}`,
        message: `${req.id} не содержит SHALL/MUST в собственном тексте`,
      });
    }
  }

  for (const cap of capabilities.keys()) {
    if (layers.layers[cap] == null) {
      findings.push({
        rule: 'unmapped-capability',
        where: capabilities.get(cap).file,
        message: `capability \`${cap}\` отсутствует в ${DEFAULT_LAYERS_PATH}`,
      });
    }
  }

  const acceptedEdges = new Set(layers.exceptions.map((x) => `${x.from}->${x.to}`));
  for (const e of capEdges.values()) {
    if (
      e.to === 'game-content' &&
      layers.layers[e.from] !== 'editor-content' &&
      !acceptedEdges.has(`${e.from}->${e.to}`)
    ) {
      findings.push({
        rule: 'content-boundary',
        where: capabilities.get(e.from).file,
        message: `механизм MUST NOT ссылаться на политику: \`${e.from}\` -> game-content (${[...e.refs].join(', ')})`,
      });
    }
  }

  return findings;
}

/** Метрики-диагностики: не гейт, читаются как список кандидатов на внимание. */
export function metrics(model, layers) {
  const fanIn = new Map();
  const fanOut = new Map();
  for (const e of model.edges) {
    fanIn.set(e.toId, (fanIn.get(e.toId) ?? 0) + 1);
    fanOut.set(e.fromId, (fanOut.get(e.fromId) ?? 0) + 1);
  }
  const topFanIn = [...fanIn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([id, count]) => ({ id, count, capability: model.requirements.get(id).capability }));

  const capIn = new Map();
  const capOut = new Map();
  for (const e of model.capEdges.values()) {
    capOut.set(e.from, (capOut.get(e.from) ?? 0) + e.weight);
    capIn.set(e.to, (capIn.get(e.to) ?? 0) + e.weight);
  }
  const instability = [...model.capabilities.keys()]
    .map((cap) => {
      const ce = capOut.get(cap) ?? 0;
      const ca = capIn.get(cap) ?? 0;
      return { capability: cap, ce, ca, instability: ce + ca === 0 ? 0 : ce / (ce + ca) };
    })
    .sort((a, b) => b.instability - a.instability);

  const orphans = [...model.requirements.keys()].filter((id) => !fanIn.has(id) && !fanOut.has(id));

  // Рёбра «вверх» по слоям — диагностика, не гейт (см. комментарий у lint()).
  // Принятые рёбра из exceptions помечаются, но не скрываются.
  const order = layers.order;
  const excepted = new Set(layers.exceptions.map((e) => `${e.from}->${e.to}`));
  const upwardEdges = [...model.capEdges.values()]
    .filter((e) => {
      const fromIdx = order.indexOf(layers.layers[e.from]);
      const toIdx = order.indexOf(layers.layers[e.to]);
      return fromIdx >= 0 && toIdx >= 0 && fromIdx < toIdx;
    })
    .map((e) => ({
      from: e.from,
      to: e.to,
      fromLayer: layers.layers[e.from],
      toLayer: layers.layers[e.to],
      weight: e.weight,
      accepted: excepted.has(`${e.from}->${e.to}`),
      refs: [...e.refs],
    }))
    .sort((a, b) => b.weight - a.weight);

  return { topFanIn, instability, orphans, upwardEdges };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `spec-graph — навигация и линт по графу спек openspec/specs/

Команды:
  find <текст>          поиск по ID, заголовкам и телам; выводит только ID и заголовки
  where <ID>            capability, файл:строка, заголовок
  show <ID...>          секция требования (+ Purpose его capability); --capability — вся спека
  refs <ID>             кого цитирует и кто цитирует
  impact <ID>           транзитивное замыкание зависимых (кто устареет от правки) + цитаты ID в коде
  code [ID...]          где ID цитируется в коде (src/test/generated); без ID — счётчики по всем требованиям
  deps <capability>     рёбра capability-уровня: от кого зависит и кто зависит
  graph [--mermaid]     весь граф capability-уровня
  check [--metrics]     линт-инварианты, включая dangling-ID в коде (exit 1 при находках); --metrics — диагностика, всегда exit 0

Флаги: --json на любой команде — структурный вывод.

Ограничение: инструмент видит только main specs. Дельта-спеки активных
changes (openspec/changes/) не парсятся: до архивации граф показывает «до».`;

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function requireReq(model, id) {
  const req = model.requirements.get(id);
  if (!req) fail(`Требование ${id} не найдено. Поиск: spec-graph find ${id}`);
  return req;
}

function out(json, jsonValue, textLines) {
  if (json) console.log(JSON.stringify(jsonValue, null, 2));
  else console.log(textLines.join('\n'));
}

function sectionText(req) {
  return `### Requirement: ${req.id} ${req.title}\n${req.body.trimEnd()}`;
}

function cmdFind(model, args, json) {
  const query = args.join(' ').toLowerCase();
  if (!query) fail('find: нужен текст запроса');
  const hits = [...model.requirements.values()].filter(
    (r) =>
      r.id.toLowerCase().includes(query) ||
      r.title.toLowerCase().includes(query) ||
      r.body.toLowerCase().includes(query),
  );
  out(
    json,
    hits.map((r) => ({ id: r.id, title: r.title, capability: r.capability })),
    hits.length
      ? hits.map((r) => `${r.id}\t${r.title}\t(${r.capability})`)
      : [`Ничего не найдено по «${query}»`],
  );
}

function cmdWhere(model, args, json) {
  const req = requireReq(model, args[0]);
  out(json, { id: req.id, title: req.title, capability: req.capability, file: req.file, line: req.line }, [
    `${req.id} ${req.title}`,
    `capability: ${req.capability}`,
    `${req.file}:${req.line}`,
  ]);
}

function cmdShow(model, args, json, flags) {
  const ids = args.filter((a) => !a.startsWith('--'));
  if (!ids.length) fail('show: нужен хотя бы один ID');
  const printedPurpose = new Set();
  const result = [];
  const lines = [];
  for (const id of ids) {
    const req = requireReq(model, id);
    const cap = model.capabilities.get(req.capability);
    if (flags.has('--capability')) {
      const full = readFileSync(cap.file, 'utf8');
      result.push({ id, capability: cap.name, file: cap.file, text: full });
      lines.push(full);
      continue;
    }
    if (!printedPurpose.has(cap.name)) {
      printedPurpose.add(cap.name);
      lines.push(`# ${cap.title} — ${cap.name} (${cap.file})`, '', cap.purpose, '');
    }
    result.push({ id, title: req.title, capability: cap.name, file: req.file, line: req.line, text: sectionText(req) });
    lines.push(sectionText(req), '');
  }
  out(json, result, lines);
}

function cmdRefs(model, args, json) {
  const req = requireReq(model, args[0]);
  const outbound = new Map();
  const inbound = new Map();
  for (const e of model.edges) {
    if (e.fromId === req.id) outbound.set(e.toId, (outbound.get(e.toId) ?? 0) + 1);
    if (e.toId === req.id) inbound.set(e.fromId, (inbound.get(e.fromId) ?? 0) + 1);
  }
  const decorate = ([id, count]) => {
    const r = model.requirements.get(id);
    return { id, count, title: r.title, capability: r.capability };
  };
  const o = [...outbound.entries()].map(decorate);
  const i = [...inbound.entries()].map(decorate);
  out(json, { id: req.id, cites: o, citedBy: i }, [
    `${req.id} цитирует (${o.length}):`,
    ...o.map((r) => `  ${r.id}\t${r.title}\t(${r.capability})`),
    `${req.id} цитируют (${i.length}):`,
    ...i.map((r) => `  ${r.id}\t${r.title}\t(${r.capability})`),
  ]);
}

function cmdImpact(model, codeIndex, args, json) {
  const req = requireReq(model, args[0]);
  const reverse = new Map();
  for (const e of model.edges) {
    if (!reverse.has(e.toId)) reverse.set(e.toId, new Set());
    reverse.get(e.toId).add(e.fromId);
  }
  const depth = new Map([[req.id, 0]]);
  const queue = [req.id];
  while (queue.length) {
    const id = queue.shift();
    for (const from of reverse.get(id) ?? []) {
      if (!depth.has(from)) {
        depth.set(from, depth.get(id) + 1);
        queue.push(from);
      }
    }
  }
  depth.delete(req.id);
  const byDepth = [...depth.entries()]
    .map(([id, d]) => ({ id, depth: d, title: model.requirements.get(id).title, capability: model.requirements.get(id).capability }))
    .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
  const code = (codeIndex.byId.get(req.id) ?? []).map((m) => ({
    file: m.file,
    line: m.line,
    category: m.category,
  }));
  out(json, { id: req.id, dependents: byDepth, code }, [
    `От правки ${req.id} могут устареть (${byDepth.length}, по удалённости):`,
    ...byDepth.map((r) => `  [${r.depth}] ${r.id}\t${r.title}\t(${r.capability})`),
    `Код, цитирующий ${req.id} (${code.length}):`,
    ...code.map((m) => `  ${m.file}:${m.line} [${m.category}]`),
  ]);
}

const CODE_CATEGORIES = ['src', 'test', 'generated'];

function cmdCode(model, codeIndex, args, json) {
  // Без аргументов — обзорные счётчики по всем требованиям (вход spec-coverage).
  if (!args.length) {
    const rows = [...model.requirements.values()].map((req) => {
      const counts = { src: 0, test: 0, generated: 0 };
      for (const m of codeIndex.byId.get(req.id) ?? []) counts[m.category] += 1;
      return { id: req.id, capability: req.capability, ...counts };
    });
    out(json, rows, [
      'ID\tsrc/test/generated\tcapability',
      ...rows.map((r) => `${r.id}\t${r.src}/${r.test}/${r.generated}\t(${r.capability})`),
    ]);
    return;
  }
  const result = [];
  const lines = [];
  for (const id of args) {
    const defined = model.requirements.has(id);
    const mentions = codeIndex.byId.get(id) ?? [];
    const by = { src: [], test: [], generated: [] };
    for (const m of mentions) by[m.category].push({ file: m.file, line: m.line });
    result.push({ id, defined, ...by });
    lines.push(`${id}${defined ? '' : ' (НЕ определён в спеках!)'} — цитат в коде: ${mentions.length}`);
    for (const cat of CODE_CATEGORIES) {
      if (!by[cat].length) continue;
      lines.push(`  ${cat} (${by[cat].length}):`);
      for (const m of by[cat]) lines.push(`    ${m.file}:${m.line}`);
    }
    if (!mentions.length && defined)
      lines.push('  (нет цитат — это не значит «не реализовано»: проверь модуль по карте CLAUDE.md)');
  }
  out(json, result, lines);
}

function cmdDeps(model, args, json) {
  const cap = args[0];
  if (!model.capabilities.has(cap)) fail(`Capability «${cap}» не найдена. Список: openspec list --specs`);
  const outEdges = [...model.capEdges.values()].filter((e) => e.from === cap);
  const inEdges = [...model.capEdges.values()].filter((e) => e.to === cap);
  const shape = (e) => ({ from: e.from, to: e.to, weight: e.weight, refs: [...e.refs] });
  out(json, { capability: cap, dependsOn: outEdges.map(shape), dependedBy: inEdges.map(shape) }, [
    `${cap} ссылается на (${outEdges.length}):`,
    ...outEdges.map((e) => `  -> ${e.to} (${e.weight})`),
    `на ${cap} ссылаются (${inEdges.length}):`,
    ...inEdges.map((e) => `  <- ${e.from} (${e.weight})`),
  ]);
}

function cmdGraph(model, layers, json, flags) {
  const edges = [...model.capEdges.values()].sort((a, b) => b.weight - a.weight);
  if (flags.has('--mermaid')) {
    const lines = ['flowchart LR'];
    for (const layer of layers.order) {
      lines.push(`  subgraph ${layer}`);
      for (const [name, l] of Object.entries(layers.layers)) if (l === layer) lines.push(`    ${name}`);
      lines.push('  end');
    }
    for (const e of edges) lines.push(`  ${e.from} --> ${e.to}`);
    out(json, { mermaid: lines.join('\n') }, lines);
    return;
  }
  out(
    json,
    edges.map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    edges.map((e) => `${e.from} -> ${e.to} (${e.weight})`),
  );
}

function cmdCheck(model, layers, codeIndex, json, flags) {
  if (flags.has('--metrics')) {
    const m = metrics(model, layers);
    out(json, m, [
      'Fan-in (топ-15 требований):',
      ...m.topFanIn.map((r) => `  ${r.id}\t${r.count}\t(${r.capability})`),
      '',
      'Instability capability (Ce/(Ca+Ce), 1 = зависит и не нужен другим):',
      ...m.instability.map((c) => `  ${c.capability}\t${c.instability.toFixed(2)}\t(out ${c.ce} / in ${c.ca})`),
      '',
      `Сироты — ни входящих, ни исходящих ссылок (${m.orphans.length}): ${m.orphans.join(', ')}`,
      '',
      'Рёбра «вверх» по слоям (диагностика; ✓ = принятое исключение):',
      ...m.upwardEdges.map(
        (e) => `  ${e.accepted ? '✓' : ' '} ${e.from} (${e.fromLayer}) -> ${e.to} (${e.toLayer}), ${e.weight}`,
      ),
    ]);
    return;
  }
  const findings = lint(model, layers, codeIndex);
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  const lines = [];
  for (const [rule, list] of byRule) {
    lines.push(`${rule} (${list.length}):`);
    for (const f of list) lines.push(`  ${f.where}`, `    ${f.message}`);
  }
  lines.push('', findings.length ? `Итого находок: ${findings.length}` : 'Граф спек зелёный.');
  out(json, { findings, total: findings.length }, lines);
  if (findings.length) process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const json = flags.has('--json');
  const [cmd, ...rest] = argv.filter((a) => !a.startsWith('--'));

  if (!cmd || flags.has('--help')) {
    console.log(HELP);
    return;
  }

  const model = buildModel();
  const layers = loadLayers();

  switch (cmd) {
    case 'find': return cmdFind(model, rest, json);
    case 'where': return cmdWhere(model, rest, json);
    case 'show': return cmdShow(model, rest, json, flags);
    case 'refs': return cmdRefs(model, rest, json);
    case 'impact': return cmdImpact(model, buildCodeIndex(), rest, json);
    case 'code': return cmdCode(model, buildCodeIndex(), rest, json);
    case 'deps': return cmdDeps(model, rest, json);
    case 'graph': return cmdGraph(model, layers, json, flags);
    case 'check': return cmdCheck(model, layers, buildCodeIndex(), json, flags);
    default: fail(`Неизвестная команда «${cmd}». spec-graph --help`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
