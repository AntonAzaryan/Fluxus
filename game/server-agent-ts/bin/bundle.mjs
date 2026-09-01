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
 * Страница игрока собирается БЕЗ копии дерева контента (`demo:build:desktop`),
 * и это часть состава дистрибутива, а не деталь сборки: раздача агента кладёт
 * бандл первым слоем (SRV-8), поэтому запечённый в него снимок дерева заслонял
 * бы живое дерево дистрибутива — сервер матча читал бы `content/`, а страница
 * игрока свою копию. Дерево в дистрибутиве поэтому ОДНО, и раздаётся именно оно.
 *
 * Страница игрока либо СОБРАНА ЭТОЙ ЖЕ командой из этого же дерева, либо её нет
 * вовсе — третьего состояния у дистрибутива не бывает, и это прямое следствие
 * SRV-7. Клиентский бандл несёт документы контента В СЕБЕ: сцена и документ
 * матча попадают в него `import`ом на сборке (`game/demo-ts/app/match.ts`), и
 * версию — `buildId` и хеш контент-пака (NET-16, NTR-5) — клиент считает из них
 * и предъявляет ею в рукопожатии. Страница, собранная не из этого дерева,
 * поэтому и ЕСТЬ вторая версия внутри дистрибутива, а «собрать дистрибутив из
 * разных версий MUST NOT быть возможно».
 *
 * Отсюда судьба флага `--client-dist`, который такую страницу принимал: он
 * отвергается названным отказом. Отвергается, а не удалён молча: скрипт, в
 * котором он написан, обязан узнать, что поведение сменилось, а не получить
 * тихо другое.
 *
 * `--skip-client` пропускает сборку страницы: дистрибутив собирается БЕЗ неё.
 * Отсутствие НЕ подменяется заглушкой и не заполняется подобранным каталогом —
 * оно названо в `distribution.json` и в отчёте: дистрибутив без страницы игрока
 * честнее и пустого каталога, и страницы неизвестного происхождения.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative as relativePath, resolve, sep } from 'node:path';
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
// Готовая страница со стороны — вторая версия контента в дистрибутиве (см.
// шапку: её версию клиент считает из документов, вкомпилированных в бандл).
// Отказ громкий и называет причину: молча сменившийся смысл флага дал бы
// старому скрипту тихо другое поведение.
if (option('client-dist', '') !== '') {
  console.error('флаг --client-dist больше не принимается: страница со стороны — это вторая версия');
  console.error('контента внутри дистрибутива (сцена и документ матча вкомпилированы в бандл, NTR-5),');
  console.error('а собрать дистрибутив из разных версий MUST NOT быть возможно (SRV-7).');
  console.error('страница либо собирается этой же командой, либо её нет: --skip-client.');
  process.exit(2);
}
const clientDist = fromRepo('game/demo-ts/app/dist-desktop');
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
// Каталог назначения СНОСИТСЯ рекурсивно, и его имя пришло из командной строки:
// `--out` без значения подхватывает следующий флаг (`--out --quiet` → каталог
// «--quiet»), а `--out .` снёс бы рабочее дерево. Отказываемся от всего, что
// содержит в себе репозиторий или текущий каталог.
const outResolved = resolve(outDir);
for (const guarded of [resolve(REPO), resolve(process.cwd())]) {
  if (guarded === outResolved || guarded.startsWith(`${outResolved}${sep}`)) {
    console.error(`каталог сборки "${outResolved}" содержит в себе "${guarded}" — отказ`);
    process.exit(2);
  }
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 1. Клиентский бандл: та же сборка, какой собирается десктоп-сборка игры, —
//    без копии дерева контента внутри бандла (см. шапку: SRV-7, SRV-8).
if (skipClient) {
  // Смысл флага СМЕНИЛСЯ: прежде он подбирал уже собранную страницу, теперь
  // страницы не будет вовсе. Сказать об этом обязан сам прогон — иначе тот, кто
  // писал флаг ради экономии времени, узнает о дистрибутиве без страницы игрока
  // только от тестера, который не смог войти (SRV-7, SRV-8).
  console.error(
    '--skip-client: страница игрока НЕ собирается и готовая со стороны не подбирается —\n' +
      'дистрибутив выйдет без неё (SRV-7). Уберите флаг, чтобы собрать страницу.',
  );
}
if (!skipClient) {
  say('  собираю клиент (vite build)…\n');
  // Команда репозитория, а не вызов vite напрямую: второй способ собрать
  // страницу был бы вторым мнением о том, как она собирается.
  //
  // Идёт она через оболочку, и это не удобство: на Windows `npm` — это
  // `npm.cmd`, а Node с 20-й версии отказывается запускать `.cmd` иначе, и шаг
  // падал `spawnSync npm ENOENT` там, где команда написана верно. Оболочке
  // отдаётся ОДНА постоянная строка: подставлять в неё нечего, поэтому
  // единственная опасность оболочки — подстановка — здесь отсутствует, а
  // массив аргументов при `shell` Node объявил устаревшим (DEP0190).
  execSync('npm run demo:build:desktop -w @fluxus/demo', {
    cwd: REPO,
    stdio: quiet ? 'ignore' : 'inherit',
  });
}
// Страница есть ровно тогда, когда её собрала ЭТА команда: подобранный с диска
// каталог прошлой сборки — тоже страница неизвестного возраста (SRV-7).
const clientBuilt = !skipClient && existsSync(clientDist);
if (clientBuilt) {
  // Самопроверка сборки: страница, несущая в себе копию дерева контента,
  // заслонила бы живое дерево первым слоем раздачи (SRV-8), и каждый запрос
  // ассета отвечал бы снимком, а не деревом, которое читает сервер матча.
  // Конфиг страницы (`vite.desktop.config.ts`) копии не кладёт, и ветка эта
  // недостижима, пока он такой; стоит она здесь на тот случай, когда он
  // перестанет быть таким, — поймать снимок в момент сборки дешевле, чем
  // отказом раздачи у человека, который дистрибутив уже скачал.
  const shadowed = readdirSync(fromRepo('content')).filter((name) =>
    existsSync(join(clientDist, name)),
  );
  if (shadowed.length > 0) {
    console.error(`каталог страницы "${clientDist}" несёт в себе копию дерева контента: ${shadowed.join(', ')}`);
    console.error('раздача агента кладёт бандл первым слоем (SRV-8), и снимок заслонил бы живое дерево');
    console.error('дистрибутива — версии внутри дистрибутива разошлись бы (SRV-7).');
    console.error('соберите страницу без копии дерева: npm run demo:build:desktop -w @fluxus/demo');
    process.exit(2);
  }
  cpSync(clientDist, join(outDir, 'client'), { recursive: true });
}

/** Откуда взялась страница игрока — ровно то, что записывается в `distribution.json` (SRV-7). */
function clientOrigin() {
  if (clientBuilt) return 'собрана сборкой дистрибутива (demo:build:desktop)';
  // Отсутствие называется ВМЕСТЕ С ПРИЧИНОЙ: пропущенная сборка и сборка, не
  // оставившая каталога, чинятся по-разному, а голое «отсутствует» не сказало бы,
  // чего не хватило.
  if (skipClient) return 'отсутствует: сборка страницы пропущена (--skip-client)';
  return `отсутствует: сборка не оставила каталога "${clientDist}"`;
}

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
  client: clientOrigin(),
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
    `Версии дистрибутива: buildId \`${distribution.buildId}\`, контент-пак \`${distribution.contentPackHash}\`.\n\n` +
    'Дистрибутив — ЕДИНИЦА: правка дерева контента внутри него не путь к обновлению.\n' +
    'Страница игрока несёт документы сцены и матча в себе (участники матча исполняют\n' +
    'одну сборку, NET-16), поэтому после правки сервер увидит новый документ, а\n' +
    'страница — прежний, и вход отклонится по хешу контент-пака (NTR-5). Меняется\n' +
    'контент — собирается дистрибутив: `npm run host:bundle`.\n',
);

say(
  `дистрибутив собран\n` +
    `  buildId: ${distribution.buildId}\n` +
    `  контент-пак: ${distribution.contentPackHash}\n` +
    `  страница игрока: ${distribution.client}\n` +
    `  каталог: ${outDir}\n`,
);
