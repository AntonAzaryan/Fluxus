#!/usr/bin/env node
/**
 * Проверка типов всех пакетов workspace параллельно: `npm run typecheck`.
 *
 * Пакеты резолвят друг друга исходником (`"main": "./src/index.ts"`, ни одного
 * `composite`), поэтому `tsc --noEmit` каждого пакета типизирует исходники
 * зависимостей заново — работа дублируется, и последовательный прогон по
 * `--workspaces` тратит на это в разы больше времени, чем занимает сама
 * типизация. Раннер не убирает дублирование (это сделали бы project references,
 * то есть шаг сборки и `.d.ts`-артефакты там, где пакеты резолвятся исходником),
 * а раскладывает его по ядрам.
 *
 * Право на параллельность даёт инвариант гейта (CLI-13): типизация ничего не
 * пишет в дерево, поэтому порядок и одновременность процессов на вердикт не
 * влияют.
 * Вердикт — конъюнкция: код ненулевой, если красен хоть один пакет, и красные
 * названы поимённо в конце вывода.
 *
 * Без аргументов проверяются все пакеты корневого манифеста; аргументами можно
 * передать подмножество — именами (`@fluxus/core`) или путями (`engine/core-ts`).
 * Этим же входом пользуется выборочный прогон (`impact.mjs`).
 *
 * Прогон одного пакета как раньше: `npm run typecheck -w @fluxus/core`.
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, loadWorkspaces, resolveSelectors } from './workspaces.mjs';

/** Бинарь компилятора берётся из корневого node_modules — тот же, что у пакетов. */
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const HELP = `typecheck — параллельная проверка типов пакетов workspace

  node scripts/typecheck.mjs [пакеты…] [--jobs N]

  пакеты   имена (@fluxus/core) или пути (engine/core-ts); без них — все
  --jobs   сколько компиляторов одновременно (умолчание — число ядер)
`;

function parseArgs(argv) {
  const selectors = [];
  let jobs = availableParallelism();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') return { help: true, selectors, jobs };
    if (arg === '--jobs' || arg.startsWith('--jobs=')) {
      const raw = arg.startsWith('--jobs=') ? arg.slice('--jobs='.length) : argv[++i];
      const parsed = Number.parseInt(raw ?? '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`--jobs ожидает число ≥ 1, получено «${raw}»`);
      jobs = parsed;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`неизвестный флаг «${arg}». node scripts/typecheck.mjs --help`);
    selectors.push(arg);
  }
  return { help: false, selectors, jobs };
}

/** Один `tsc --noEmit` в каталоге пакета; вывод копится, чтобы не смешаться с соседним. */
function runPackage(pkg) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSC, '--noEmit'], {
      cwd: join(REPO_ROOT, pkg.dir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => {
      chunks.push(Buffer.from(`не удалось запустить tsc: ${err.message}\n`));
      resolve({ pkg, code: 1, output: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      resolve({ pkg, code: code ?? 1, output: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started });
    });
  });
}

/** Отчёт о пакете печатается по его завершении: имя пакета — префикс каждой строки. */
function report(result) {
  const seconds = (result.ms / 1000).toFixed(1);
  if (result.code === 0) {
    console.log(`[${result.pkg.name}] типы в порядке (${seconds} с)`);
    return;
  }
  console.log(`[${result.pkg.name}] КРАСНЫЙ (${seconds} с)`);
  for (const line of result.output.split('\n')) {
    if (line.trim() !== '') console.log(`[${result.pkg.name}] ${line}`);
  }
}

/** Очередь на `jobs` одновременных процессов: следующий стартует по завершении предыдущего. */
async function runAll(packages, jobs) {
  const queue = [...packages];
  const results = [];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const result = await runPackage(next);
      report(result);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, packages.length) }, worker));
  return results;
}

async function main() {
  const { help, selectors, jobs } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(HELP);
    return;
  }
  const workspaces = loadWorkspaces();
  const packages = selectors.length > 0 ? resolveSelectors(selectors, workspaces) : workspaces;
  if (packages.length === 0) {
    console.log('typecheck: пакетов не выбрано — проверять нечего');
    return;
  }

  const started = Date.now();
  console.log(`typecheck: ${packages.length} пакет(ов), параллельность ${jobs}`);
  const results = await runAll(packages, jobs);
  const failed = results.filter((r) => r.code !== 0).map((r) => r.pkg.name);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (failed.length === 0) {
    console.log(`typecheck: все ${packages.length} пакет(ов) зелёные за ${seconds} с`);
    return;
  }
  console.error(`typecheck: красные пакеты (${failed.length} из ${packages.length}): ${failed.join(', ')}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`typecheck: ${err.message}`);
  process.exitCode = 1;
});
