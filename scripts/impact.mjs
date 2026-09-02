#!/usr/bin/env node
/**
 * impact — выборочный прогон гейта по карте влияния: `npm run check:impact`.
 *
 * По диффу дерева от базы (общий предок с основной веткой плюс незакоммиченное
 * и неотслеживаемое) выбирает, какие проверки полного гейта запускать. Единица
 * выбора — ПАКЕТ workspace, а не файл: тесты репозитория читают чужие деревья с
 * диска и спавнят процессы, и граф модулей этих рёбер не видит — файловая
 * выборка молча теряла бы двадцать зависящих тестов на правке сцены. Пакетная
 * гранулярность делает такую потерю невозможной внутри пакета, а между
 * пакетами её закрывает объявленная карта (`TEST_EDGES`) и её механический
 * сторож в обычном прогоне тестов (engine/integration-ts/test/impactMap.test.ts).
 *
 * Выборка НЕ ворота основной ветки. Перед пушем в `main` клиентский хук
 * `scripts/git-hooks/pre-push` по-прежнему гонит полный `npm run check`, и этот
 * скрипт его не заменяет и не вызывается из него. Отсюда и цена ошибки карты:
 * лишний полный прогон, а не пропущенный регресс.
 *
 * Карта — данные этого файла (широкие ворота, документные правила, тест-рёбра),
 * по образцу списков guard-сканера (CLI-8): её правка обязана попадать в дифф на
 * ревью, а не прятаться в эвристике. Fail-closed: путь, не подошедший ни под
 * одно правило, даёт полный гейт.
 *
 * Требования, которые здесь реализованы (состав и инвариант гейта, выборочный
 * прогон по карте влияния), живут в дельте change'а `gate-impact-mapping`
 * capability `cli-testing` и в главные спеки попадут при архивации: до неё
 * цитата их ID в коде была бы для `spec-graph check` висячей ссылкой.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT, loadWorkspaces } from './workspaces.mjs';

// ---------------------------------------------------------------------------
// Карта влияния — данные
// ---------------------------------------------------------------------------

/**
 * Широкие ворота: деревья и файлы, правка которых даёт ПОЛНЫЙ гейт.
 *
 * Общее у них одно — их читают мимо графа модулей (строкой пути, `readdirSync`,
 * спавном процесса) или они меняют правила проверки для всех сразу. Замер это и
 * показал: правка эталона `engine/tests/golden/*.golden.json` не выбирает ни
 * одного тестового файла по графу модулей, потому что сравнивающий тест ходит
 * по каталогу.
 */
export const WIDE_GATES = [
  {
    rule: 'content',
    why: 'дерево контента: сцены, матчи, манифест и профили ботов тесты читают строкой пути (CONT-1)',
    match: (p) => p.startsWith('content/'),
  },
  {
    rule: 'engine-tests',
    why: 'эталоны и сценарии: сравнивающий тест обходит каталог, графу модулей эта связь не видна (CLI-7)',
    match: (p) => p.startsWith('engine/tests/'),
  },
  {
    rule: 'engine-schemas',
    why: 'сгенерированные схемы: правятся только через npm run schemas и сверяются тестами нескольких пакетов (CLI-5)',
    match: (p) => p.startsWith('engine/schemas/'),
  },
  {
    rule: 'scripts',
    why: 'скрипты репозитория: сама карта влияния, раннер типизации и линт графа спек',
    match: (p) => p.startsWith('scripts/'),
  },
  {
    rule: 'harness',
    why: 'обвязка репозитория: hook-и, настройки и вспомогательные скрипты агентов',
    match: (p) => p.startsWith('.claude/') && !p.endsWith('.md'),
  },
  {
    rule: 'blender-addon',
    why: 'Python-надстройка Blender вне workspace: её состав проверяет boundary-тест интеграционной сюиты (BLND-8)',
    match: (p) => p.startsWith('tools/blender-addon/'),
  },
  {
    rule: 'root-config',
    why: 'корневой конфиг репозитория: правила линта, покрытия, проектов и зависимостей — общие для всех пакетов',
    match: (p) => !p.includes('/') && !p.endsWith('.md'),
  },
  {
    rule: 'tsconfig',
    why: 'конфиг компилятора: меняет типизацию пакета и всех, кто резолвит его исходником',
    match: (p) => /(^|\/)tsconfig[^/]*\.json$/.test(p),
  },
  {
    rule: 'manifest',
    why: 'манифест пакета: зависимости и скрипты — из них строится само замыкание карты',
    match: (p) => /(^|\/)package\.json$/.test(p),
  },
  {
    rule: 'lockfile',
    why: 'lock-файл: версии зависимостей меняются сразу у всех пакетов',
    match: (p) => p === 'package-lock.json',
  },
];

/**
 * Документы: спеки, документация и любой markdown. Дифф, целиком состоящий из
 * них, идёт быстрым путём — линт графа спек и тесты, читающие дерево спек.
 */
export const DOC_RULES = [
  { rule: 'openspec', why: 'дерево спек', match: (p) => p.startsWith('openspec/') },
  { rule: 'docs', why: 'документация репозитория', match: (p) => p.startsWith('docs/') },
  { rule: 'markdown', why: 'markdown-документ', match: (p) => p.endsWith('.md') },
];

/**
 * Тест-рёбра «читающий ← читаемые»: пакет читает ЧУЖОЕ дерево мимо манифеста, и
 * замыкание по объявленным зависимостям такой связи не видит.
 *
 * Сегодня их два источника. Десктоп-контейнер не зависит от приложений ни одной
 * строкой манифеста (DSK-3 запрещает ему знать про пакеты движка и редактора),
 * но его тесты профилей проверяют пути бандлов и бинов этих приложений. Агент
 * хоста раздаёт клиент сборки игры и знает путь до неё.
 *
 * Список — данные: полноту держит сторож impactMap.test.ts, который сканирует
 * литералы путей в `test/` и `bin/` каждого пакета по AST.
 */
export const TEST_EDGES = {
  'desktop/shell-ts': ['editor/ui-ts', 'game/demo-ts', 'game/server-agent-ts', 'game/server-manager-ts'],
  'game/server-agent-ts': ['game/demo-ts'],
};

/**
 * Интеграционная сюита входит в любую непустую выборку кода (CLI-9): её
 * boundary-тесты сканируют всё дерево репозитория, а не импортируют его.
 */
export const ALWAYS_ON_CODE = 'engine/integration-ts';

/** Причина попадания в выборку — текст для `--explain`. */
const WHY_DIFF = 'изменён диффом';
const WHY_INTEGRATION = 'интеграционная сюита: её проверки границ читают всё дерево (CLI-9)';

// ---------------------------------------------------------------------------
// Классификация и замыкание
// ---------------------------------------------------------------------------

/**
 * Правило, под которое подходит путь. Порядок — широкие ворота, документы,
 * пакет, и только потом fail-closed: неизвестный путь даёт полный гейт, потому
 * что карта не знает, кто его читает.
 */
export function classify(path, workspaces) {
  const p = path.replace(/^\.\//, '');
  for (const gate of WIDE_GATES) {
    if (gate.match(p)) return { kind: 'full', rule: gate.rule, why: gate.why };
  }
  for (const doc of DOC_RULES) {
    if (doc.match(p)) return { kind: 'docs', rule: doc.rule, why: doc.why };
  }
  const pkg = workspaces.find((w) => p === w.dir || p.startsWith(`${w.dir}/`));
  if (pkg !== undefined) return { kind: 'pkg', rule: 'package', pkg: pkg.dir, why: `путь пакета ${pkg.name}` };
  return { kind: 'full', rule: 'unknown', why: 'путь не подошёл ни под одно правило карты — полный гейт (fail-closed)' };
}

/**
 * Обратное замыкание выборки. Возвращает Map «каталог пакета → чем выбран».
 *
 * Две фазы, и они разные по природе. Обратные зависимости по манифестам
 * транзитивны: изменившийся исходник меняет поведение того, кто его импортирует,
 * а через него — и следующего. Тест-ребро транзитивным НЕ является и обрывает
 * замыкание на себе: оно означает «тесты этого пакета читают чужое дерево», то
 * есть от чужой правки может покраснеть его СЮИТА, а не его код, — и потребители
 * такого пакета от неё не меняются. Пример прямо из карты: правка `editor/ui-ts`
 * краснит тесты профилей десктоп-контейнера, но не сборку игры, которая от
 * контейнера зависит.
 *
 * Зависимости берутся из манифестов, а не из списка в коде: новое ребро
 * `@fluxus/*` попадает в замыкание само, без правки карты.
 */
export function closure(seeds, workspaces, testEdges = TEST_EDGES) {
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const selected = new Map();
  const queue = [];
  const add = (dir, why) => {
    if (selected.has(dir) || !byDir.has(dir)) return;
    selected.set(dir, why);
    queue.push(dir);
  };
  for (const dir of seeds) add(dir, WHY_DIFF);

  for (let head = 0; head < queue.length; head++) {
    const dir = queue[head];
    const name = byDir.get(dir).name;
    for (const candidate of workspaces) {
      if (!selected.has(candidate.dir) && candidate.deps.includes(name)) {
        add(candidate.dir, `зависит по манифесту ← ${dir}`);
      }
    }
  }

  const readable = new Set(selected.keys());
  for (const candidate of workspaces) {
    if (selected.has(candidate.dir)) continue;
    const edge = (testEdges[candidate.dir] ?? []).find((dir) => readable.has(dir));
    if (edge !== undefined) selected.set(candidate.dir, `тест-ребро карты ← ${edge}`);
  }

  if (selected.size > 0 && !selected.has(ALWAYS_ON_CODE) && byDir.has(ALWAYS_ON_CODE)) {
    selected.set(ALWAYS_ON_CODE, WHY_INTEGRATION);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// План
// ---------------------------------------------------------------------------

/**
 * План прогона по списку изменённых путей.
 *
 * Виды: `full` — полный гейт; `docs` — только линт графа спек и тесты, читающие
 * дерево спек; `selective` — выбранные пакеты плюс глобальные проверки целиком;
 * `global-only` — пустой дифф, остаются только глобальные проверки.
 */
export function planFor(paths, workspaces, testEdges = TEST_EDGES) {
  const rules = paths.map((path) => ({ path, ...classify(path, workspaces) }));
  const seeds = [...new Set(rules.filter((r) => r.kind === 'pkg').map((r) => r.pkg))];
  const wide = rules.filter((r) => r.kind === 'full');

  if (wide.length > 0) {
    return { kind: 'full', rules, packages: [], typecheck: [], lint: [], test: [], global: true };
  }
  if (seeds.length === 0) {
    const kind = rules.length > 0 ? 'docs' : 'global-only';
    return { kind, rules, packages: [], typecheck: [], lint: [], test: [], global: kind === 'global-only' };
  }

  const selected = closure(seeds, workspaces, testEdges);
  const byDir = new Map(workspaces.map((w) => [w.dir, w]));
  const packages = [...selected.entries()]
    .map(([dir, why]) => ({ dir, name: byDir.get(dir).name, why }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
  return {
    kind: 'selective',
    rules,
    packages,
    typecheck: packages.map((p) => p.dir),
    lint: packages.map((p) => p.dir),
    test: packages.map((p) => p.name),
    global: true,
  };
}

// ---------------------------------------------------------------------------
// Дифф от базы
// ---------------------------------------------------------------------------

function git(args, quiet = false) {
  const stdio = quiet ? { stdio: ['ignore', 'pipe', 'ignore'] } : {};
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...stdio });
}

/** Пробующий вызов: отказ здесь — обычный ответ «такой ссылки нет», и ругань git в него не входит. */
function gitOrNull(args) {
  try {
    return git(args, true).trim();
  } catch {
    return null;
  }
}

/**
 * База сравнения: общий предок с основной веткой. `origin/main` предпочтительнее
 * локальной `main` — локальная отстаёт молча. Неразрешимая база не «сужается до
 * HEAD», а честно даёт полный гейт: устаревшая база расширяет дифф, а отсутствие
 * базы означало бы, что мы не знаем, что изменилось.
 */
export function resolveBase(explicit = null) {
  if (explicit !== null) {
    // Именно merge-base, а не сама ссылка: `--base origin/main` на отставшей
    // ветке иначе притащил бы в дифф чужие правки самой main — выборка вышла бы
    // шире (безопасно), но перестала бы отвечать на вопрос «что сделал я».
    const merged = gitOrNull(['merge-base', 'HEAD', explicit]);
    return merged === null
      ? { base: null, warning: `база «${explicit}» не разрешается — полный гейт` }
      : { base: merged, ref: explicit, warning: null };
  }
  for (const ref of ['origin/main', 'main']) {
    const merged = gitOrNull(['merge-base', 'HEAD', ref]);
    if (merged !== null) {
      const warning = ref === 'main' ? 'origin/main не подтянут — база взята от локальной main' : null;
      return { base: merged, ref, warning };
    }
  }
  return { base: null, warning: 'ни origin/main, ни main не разрешаются — полный гейт' };
}

/** Пути рабочего дерева: staged, unstaged и неотслеживаемые (`git status --porcelain`). */
function worktreePaths() {
  const out = [];
  for (const line of git(['status', '--porcelain']).split('\n')) {
    if (line.trim() === '') continue;
    const body = line.slice(3);
    const arrow = body.indexOf(' -> ');
    if (arrow === -1) out.push(body.replace(/^"|"$/g, ''));
    else out.push(body.slice(0, arrow).replace(/^"|"$/g, ''), body.slice(arrow + 4).replace(/^"|"$/g, ''));
  }
  return out;
}

/**
 * Отслеживаемые пути дерева. Живёт здесь, а рядом с чтением диффа, не в тесте:
 * весь разговор с git у выборки в одном месте, и пакеты гейта остаются без
 * импорта запуска подпроцесса — единственного канала, которым из них можно было
 * бы позвать Blender (BLND-7).
 */
export function trackedPaths() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

/** Дифф от базы ∪ рабочее дерево: проверяется то, что видит разработчик, а не то, что закоммичено. */
export function changedPaths(base) {
  const committed = base === null ? [] : git(['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean);
  return [...new Set([...committed, ...worktreePaths()])].sort();
}

// ---------------------------------------------------------------------------
// Инвариант стадий: гейт не пишет в дерево
// ---------------------------------------------------------------------------

/**
 * Снимок рабочего дерева для сравнения «до/после» прогона: статусные строки и
 * СОДЕРЖИМОЕ изменённого.
 *
 * Одного `git status --porcelain` мало, и это не перестраховка: у файла, уже
 * грязного до прогона, строка статуса ` M path` остаётся той же и после того,
 * как стадия перепишет его целиком, — эталон, регенерированный поверх правки
 * разработчика, прошёл бы проверку молча. Патч `git diff HEAD` покрывает
 * содержимое отслеживаемых файлов (и staged, и unstaged), а появление и
 * исчезновение неотслеживаемых по-прежнему видно по статусу.
 */
export function treeSnapshot() {
  return { status: git(['status', '--porcelain']), patch: gitOrNull(['diff', 'HEAD']) ?? '' };
}

/**
 * Патч по путям: `git diff HEAD` — это конкатенация файловых диффов, каждый со
 * своим заголовком `diff --git a/… b/…`. Путь берётся из правой стороны
 * заголовка; путь с пробелами регулярка разберёт неточно, но это ухудшает
 * ТОЧНОСТЬ имени в находке, а не её наличие — содержимое сравнивается всё равно.
 */
function patchByPath(patch) {
  const byPath = new Map();
  let current = null;
  let lines = [];
  const flush = () => {
    if (current !== null) byPath.set(current, lines.join('\n'));
  };
  for (const line of patch.split('\n')) {
    const header = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (header) {
      flush();
      current = header[2];
      lines = [];
    }
    if (current !== null) lines.push(line);
  }
  flush();
  return byPath;
}

/**
 * Расхождение снимков: строки статуса, появившиеся или исчезнувшие между «до» и
 * «после», плюс пути, у которых статусная строка та же, а содержимое другое.
 *
 * Стадия гейта, изменившая отслеживаемое дерево, — дефект: вердикт обязан быть
 * функцией дерева, а не порядка стадий, а регенерация эталонов и схем — отдельные
 * явные команды (CLI-5), а не побочный эффект прогона.
 */
export function snapshotDiff(before, after) {
  const asSet = (text) => new Set(text.split('\n').filter((l) => l.trim() !== ''));
  const from = asSet(before.status);
  const to = asSet(after.status);
  const findings = [
    ...[...to].filter((l) => !from.has(l)).map((l) => `+ ${l}`),
    ...[...from].filter((l) => !to.has(l)).map((l) => `- ${l}`),
  ];
  const wasPatch = patchByPath(before.patch);
  for (const [path, text] of patchByPath(after.patch)) {
    const previous = wasPatch.get(path);
    if (previous !== undefined && previous !== text) findings.push(`~ ${path} — содержимое изменилось`);
  }
  return findings.sort();
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

const bin = (name, args) => [process.execPath, [join(REPO_ROOT, 'node_modules', '.bin', name), ...args]];
const npm = (args) => ['npm', args];

const GLOBAL_STAGES = [
  { name: 'lint:dead', cmd: npm(['run', 'lint:dead']) },
  { name: 'lint:dup', cmd: npm(['run', 'lint:dup']) },
  { name: 'lint:arch', cmd: npm(['run', 'lint:arch']) },
  { name: 'spec-graph', cmd: npm(['run', 'spec-graph', '--', 'check']) },
];

/**
 * Стадии плана. Полный план — ровно те же семь команд, из которых состоит
 * `npm run check`, разложенные по стадиям: вердикт обязан совпадать с ним, а не
 * приближаться к нему.
 */
export function stagesFor(plan, jobs = null) {
  if (plan.kind === 'full') {
    return [
      { name: 'typecheck', cmd: npm(['run', 'typecheck', ...(jobs === null ? [] : ['--', '--jobs', String(jobs)])]) },
      { name: 'lint', cmd: npm(['run', 'lint']) },
      ...GLOBAL_STAGES,
      { name: 'test', cmd: npm(['test']) },
    ];
  }
  if (plan.kind === 'docs') {
    return [
      { name: 'spec-graph', cmd: npm(['run', 'spec-graph', '--', 'check']) },
      {
        name: 'test',
        cmd: bin('vitest', ['run', '--config', 'vitest.gate.config.ts', '--project', '@fluxus/integration', 'specGraph']),
      },
    ];
  }
  const stages = [];
  if (plan.typecheck.length > 0) {
    const args = ['scripts/typecheck.mjs', ...plan.typecheck, ...(jobs === null ? [] : ['--jobs', String(jobs)])];
    stages.push({ name: 'typecheck', cmd: [process.execPath, args] });
  }
  if (plan.lint.length > 0) {
    stages.push({ name: 'lint', cmd: bin('eslint', [...plan.lint, '--max-warnings', '0']) });
  }
  stages.push(...GLOBAL_STAGES);
  if (plan.test.length > 0) {
    const projects = plan.test.flatMap((name) => ['--project', name]);
    stages.push({ name: 'test', cmd: bin('vitest', ['run', '--config', 'vitest.gate.config.ts', ...projects]) });
  }
  return stages;
}

function runStages(stages) {
  const timings = [];
  const failed = [];
  for (const stage of stages) {
    const started = Date.now();
    const [command, args] = stage.cmd;
    console.log(`\n=== ${stage.name}`);
    const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    const ok = result.status === 0;
    timings.push({ name: stage.name, ms: Date.now() - started, ok });
    if (!ok) failed.push(stage.name);
  }
  return { timings, failed };
}

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------

const KIND_TEXT = {
  full: 'полный гейт',
  docs: 'документный прогон: линт графа спек и тесты, читающие дерево спек',
  selective: 'выборочный прогон',
  'global-only': 'дифф пуст: только глобальные проверки',
};

function printExplain(plan, log) {
  log('\nпуть → правило:');
  for (const rule of plan.rules) log(`  ${rule.path}\n    ${rule.rule} → ${rule.kind}: ${rule.why}`);
  if (plan.packages.length === 0) return;
  log('\nпакет → кем выбран:');
  for (const pkg of plan.packages) log(`  ${pkg.dir} (${pkg.name})\n    ${pkg.why}`);
}

function printTimings(timings, log) {
  log('\nстоимость стадий (секунды, без порога — диагностика по образцу бенчей, PERF-5):');
  let total = 0;
  for (const t of timings) {
    total += t.ms;
    log(`  ${t.name.padEnd(12)} ${(t.ms / 1000).toFixed(1).padStart(7)}  ${t.ok ? 'зелёная' : 'КРАСНАЯ'}`);
  }
  log(`  ${'итого'.padEnd(12)} ${(total / 1000).toFixed(1).padStart(7)}`);
}

const HELP = `impact — выборочный прогон гейта по карте влияния

  npm run check:impact -- [флаги]

  --base <ref>   база сравнения (умолчание — merge-base с origin/main)
  --full         принудительно полный план
  --dry-run      напечатать план (JSON в stdout) и выйти
  --explain      путь → правило, пакет → кем выбран
  --timings      секунды по стадиям
  --jobs N       параллельность проверки типов

Выборка НЕ ворота main: перед пушем в основную ветку гонится полный npm run check.
`;

function parseArgs(argv) {
  const opts = { base: null, full: false, dryRun: false, explain: false, timings: false, jobs: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') opts.help = true;
    else if (arg === '--full') opts.full = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--explain') opts.explain = true;
    else if (arg === '--timings') opts.timings = true;
    else if (arg === '--base') opts.base = argv[++i] ?? null;
    else if (arg === '--jobs') opts.jobs = Number.parseInt(argv[++i] ?? '', 10);
    else throw new Error(`неизвестный флаг «${arg}». npm run check:impact -- --help`);
  }
  return opts;
}

function buildPlan(opts, workspaces, log) {
  if (opts.full) {
    log('план: полный гейт (--full)');
    return { kind: 'full', rules: [], packages: [], typecheck: [], lint: [], test: [], global: true };
  }
  const { base, ref, warning } = resolveBase(opts.base);
  if (warning !== null) log(`внимание: ${warning}`);
  if (base === null) return { kind: 'full', rules: [], packages: [], typecheck: [], lint: [], test: [], global: true };
  log(`база: ${ref ?? 'HEAD'} (${base.slice(0, 8)})`);
  const paths = changedPaths(base);
  log(`изменено путей: ${paths.length}`);
  return planFor(paths, workspaces);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  // В режиме плана stdout занят JSON'ом — человеческий текст уходит в stderr.
  const log = opts.dryRun ? (line) => console.error(line) : (line) => console.log(line);

  log('Выборочный прогон гейта. Ворота main это НЕ заменяет: перед пушем — полный npm run check.');
  const workspaces = loadWorkspaces();
  const plan = buildPlan(opts, workspaces, log);
  log(`план: ${KIND_TEXT[plan.kind]}`);
  if (plan.packages.length > 0) log(`пакеты (${plan.packages.length}): ${plan.packages.map((p) => p.name).join(', ')}`);
  if (opts.explain) printExplain(plan, log);

  const stages = stagesFor(plan, Number.isFinite(opts.jobs) ? opts.jobs : null);
  if (opts.dryRun) {
    // В JSON уходит сам план без построчной классификации: она — материал
    // `--explain`, и на диффе в сотню путей затопила бы план собой.
    const summary = {
      kind: plan.kind,
      paths: plan.rules.length,
      packages: plan.packages,
      typecheck: plan.typecheck,
      lint: plan.lint,
      test: plan.test,
      global: plan.global,
      stages: stages.map((stage) => stage.name),
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const before = treeSnapshot();
  const { timings, failed } = runStages(stages);
  const touched = snapshotDiff(before, treeSnapshot());

  if (opts.timings) printTimings(timings, log);
  if (touched.length > 0) {
    console.error('\nстадия гейта изменила отслеживаемое дерево — вердикт обязан быть функцией дерева, а не прогона:');
    for (const line of touched) console.error(`  ${line}`);
    console.error('регенерация эталонов и схем — отдельные явные команды (CLI-5), а не побочный эффект прогона.');
    process.exitCode = 1;
  }
  if (failed.length > 0) {
    console.error(`\nкрасные стадии: ${failed.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (touched.length === 0) log(`\n${KIND_TEXT[plan.kind]}: зелено, ${stages.length} стад. Ворота main — полный npm run check.`);
}

if (process.argv[1]?.endsWith('impact.mjs')) {
  try {
    main();
  } catch (err) {
    console.error(`impact: ${err.message}`);
    process.exitCode = 1;
  }
}
