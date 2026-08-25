#!/usr/bin/env node
/**
 * Сборка дистрибутива хоста (SRV-7, решение D10) — ОДНОЙ командой:
 *
 *   npm run host:bundle [-- --out dist/host-bundle] [--match content/matches/duel.match.json]
 *                          [--skip-client]
 *
 * Состав дистрибутива согласован ПО ПОСТРОЕНИЮ: агент, запускалка сервера матча,
 * собранный клиентский бандл и дерево контента кладутся вместе, а версии
 * (`buildId` документа матча и хеш контент-пака, NET-16 и NTR-5) считаются ЗДЕСЬ
 * же, из тех самых файлов, которые уехали в дистрибутив, и записываются
 * `distribution.json`. Собрать дистрибутив из разных версий поэтому невозможно:
 * второго источника версий в нём нет.
 *
 * Каталог самодостаточен: пакеты кладутся в `node_modules` дистрибутива, поэтому
 * агент, поднятый ИЗ НЕГО, находит и запускалку стенда, и контент, и бандл, не
 * заглядывая в репозиторий. Снаружи остаётся только рантайм Node — как и у
 * всякой запускалки репозитория.
 *
 * `--skip-client` пропускает `vite build`: он нужен там, где бандл уже собран.
 * Отсутствующий бандл при этом НЕ подменяется заглушкой — он назван
 * отсутствующим в `distribution.json` и в отчёте: дистрибутив без страницы
 * игрока честнее молча пустого каталога.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flag, option, readMatchFile } from '@fluxus/net/bin/matchFile.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const fromRepo = (relative) => join(REPO, relative);

if (flag('help')) {
  process.stdout.write(
    'usage: npm run host:bundle [-- --out dist/host-bundle] [--match content/matches/duel.match.json]\n' +
      '                           [--skip-client]\n',
  );
  process.exit(0);
}

const outDir = resolve(process.cwd(), option('out', fromRepo('dist/host-bundle')));
const matchPath = resolve(process.cwd(), option('match', fromRepo('content/matches/duel.match.json')));
const skipClient = flag('skip-client');
const quiet = flag('quiet');
const say = (text) => { if (!quiet) process.stdout.write(text); };

const { contentPack } = await import('@fluxus/net');

/**
 * Корни дистрибутива: агент и сборка игры, чья запускалка и есть сервер матча.
 * Всё остальное — их ЗАМЫКАНИЕ по манифестам, а не список, который забывают
 * дописать: разойдись он с манифестом, дистрибутив падал бы на первом же
 * `import` — и падал бы у тестера, а не у собравшего.
 */
const HOST_ROOTS = ['@fluxus/server-agent', '@fluxus/demo'];

/** Каталоги пакетов workspace по именам: раскладка приезжает из корневого манифеста. */
function workspaceDirs() {
  const root = JSON.parse(readFileSync(fromRepo('package.json'), 'utf8'));
  const found = new Map();
  for (const member of root.workspaces ?? []) {
    const manifest = fromRepo(join(member, 'package.json'));
    if (!existsSync(manifest)) continue;
    found.set(JSON.parse(readFileSync(manifest, 'utf8')).name, member);
  }
  return found;
}

/**
 * Пакет workspace в дистрибутиве: сам каталог лежит по своему пути репозитория,
 * а `node_modules/<имя>` — ССЫЛКА на него.
 *
 * Ссылка, а не копия внутрь `node_modules`, по прямой причине: рантайм Node
 * отказывается стрипать типы у файлов ПОД `node_modules`, а пакеты репозитория
 * — это исходники на TypeScript. Ровно так же устроен и сам репозиторий: npm
 * связывает участников workspace ссылками, и запускалки работают.
 */
function linkPackage(name, member) {
  copyTree(fromRepo(member), join(outDir, member));
  const link = join(outDir, 'node_modules', name);
  mkdirSync(dirname(link), { recursive: true });
  if (process.platform === 'win32') {
    // На Windows обычная ссылка требует прав, а junction — нет; цель у неё
    // обязана быть абсолютной.
    symlinkSync(join(outDir, member), link, 'junction');
    return;
  }
  symlinkSync(relativePath(dirname(link), join(outDir, member)), link, 'dir');
}

/**
 * Замыкание зависимостей от корней: что из workspace, что стороннее.
 *
 * Обходятся только `dependencies` — то, что нужно в РАНТАЙМЕ. `devDependencies`
 * (vitest, typescript, electron) остаются снаружи: дистрибутив не собирают и не
 * тестируют, его запускают.
 */
function closureOf(roots, workspace) {
  const packages = new Set();
  const vendors = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (packages.has(name) || vendors.has(name)) continue;
    const member = workspace.get(name);
    const manifest = member === undefined
      ? fromRepo(join('node_modules', name, 'package.json'))
      : fromRepo(join(member, 'package.json'));
    if (!existsSync(manifest)) {
      process.stderr.write(`зависимость "${name}" не установлена: соберите после npm install\n`);
      process.exit(2);
    }
    if (member === undefined) vendors.add(name);
    else packages.add(name);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const dependency of Object.keys(parsed.dependencies ?? {})) queue.push(dependency);
  }
  return { packages: [...packages], vendors: [...vendors] };
}

/** Копия каталога без `node_modules`: чужие деревья дистрибутиву не нужны. */
function copyTree(source, target) {
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => !path.split(/[\\/]/).includes('node_modules'),
  });
}

say(`сборка дистрибутива хоста → ${outDir}\n`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Клиентский бандл: тот же `vite build`, каким собирается десктоп-сборка игры.
const clientDist = fromRepo('game/demo-ts/app/dist');
if (!skipClient) {
  say('  собираю клиент (vite build)…\n');
  execFileSync('npm', ['run', 'demo:build', '-w', '@fluxus/demo'], { cwd: REPO, stdio: quiet ? 'ignore' : 'inherit' });
}
const clientBuilt = existsSync(clientDist);
if (clientBuilt) cpSync(clientDist, join(outDir, 'client'), { recursive: true });

// 2. Дерево контента — целиком: сервер поднимает по нему матч, клиент читает
//    ассеты той же раздачей (SRV-8).
copyTree(fromRepo('content'), join(outDir, 'content'));

// 3. Код хоста в `node_modules` дистрибутива: агент, стенд и то, на чём они
//    стоят. Копируются исходники — типы рантайм стрипает сам (>=22.18), тем же
//    способом, каким запускаются все бины репозитория.
const dirs = workspaceDirs();
const closure = closureOf(HOST_ROOTS, dirs);
for (const name of closure.packages) linkPackage(name, dirs.get(name));
for (const name of closure.vendors) {
  // Сторонний пакет копируется ЦЕЛИКОМ, без фильтра `copyTree`: он сам живёт
  // под `node_modules`, и тот фильтр вымел бы его до последнего файла.
  cpSync(fromRepo(join('node_modules', name)), join(outDir, 'node_modules', name), {
    recursive: true,
    dereference: true,
  });
}

// 4. Версии — из ТЕХ ЖЕ файлов, что уехали в дистрибутив (SRV-7): хеш
//    контент-пака считается кодом, которым его считают сервер и клиент (NET-17),
//    а не переписывается руками.
const match = readMatchFile(matchPath);
const pack = contentPack(match.scenes);
const distribution = {
  name: 'fluxus-host-bundle',
  buildId: match.buildId ?? '',
  contentPackHash: pack.hash,
  match: matchPath.slice(REPO.length + 1),
  builtWith: process.version,
  client: clientBuilt ? (skipClient ? 'взят готовым (--skip-client)' : 'собран vite build') : 'отсутствует',
};
writeFileSync(join(outDir, 'distribution.json'), `${JSON.stringify(distribution, null, 2)}\n`);

// 5. Команда запуска — рядом с дистрибутивом, чтобы её не пришлось вспоминать.
const agentPath = `${dirs.get('@fluxus/server-agent')}/bin/agent.mjs`;
writeFileSync(
  join(outDir, 'START.md'),
  '# Дистрибутив хоста Fluxus\n\n' +
    'Запуск агента из этого каталога:\n\n' +
    '```sh\n' +
    `node ${agentPath} \\\n` +
    '  --content content --bundle client \\\n' +
    `  --stand ${dirs.get('@fluxus/demo')}/bin/demo-serve.mjs\n` +
    '```\n\n' +
    'Пейринг менеджера (локальная команда на хосте):\n\n' +
    '```sh\n' +
    `node ${agentPath} pair\n` +
    '```\n\n' +
    `Версии дистрибутива: buildId \`${distribution.buildId}\`, контент-пак \`${distribution.contentPackHash}\`.\n`,
);

say(
  `дистрибутив собран\n` +
    `  buildId: ${distribution.buildId}\n` +
    `  контент-пак: ${distribution.contentPackHash}\n` +
    `  страница игрока: ${distribution.client}\n` +
    `  каталог: ${outDir}\n`,
);
