#!/usr/bin/env node
/**
 * Сборка дистрибутива контейнера с одним профилем — вне гейта (DSK-6).
 *
 * Шаг один и он подготовительный: разложить приложение так, чтобы внутри
 * дистрибутива профиль указывал на СОСЕДНИЕ каталоги, а не на дерево
 * репозитория. Отсюда staging в `build/<app>/`:
 *
 *   build/<app>/package.json          манифест приложения (main — entry контейнера)
 *   build/<app>/src/                  контейнер: bridge, host, electron
 *   build/<app>/profile.app.json      профиль с путями внутрь дистрибутива
 *   build/<app>/bundle/               собранный веб-бандл приложения
 *   build/<app>/content/              дерево контента
 *
 * Что дальше делает с этим каталогом упаковщик (electron-builder), сюда не
 * входит: `--stage` останавливается на разложенном каталоге, без флага —
 * зовётся упаковщик. Так предусловия и отказы упаковщика не путаются с
 * подготовкой, а сама подготовка проверяема глазами.
 *
 * Открытый вопрос, названный в design.md: дерево контента внутри дистрибутива
 * — снимок. Игре это ровно то, что нужно (контент — часть игры); редактору
 * снимок годится для dev-дистрибутива, а «редактор открывает ЧУЖОЙ проект»
 * решается профилем при выборе структуры дистрибутивов и контракта не меняет.
 *
 * Запуск: `npm run pack -w @fluxus/desktop-shell -- game [--stage] [--linux dir]`
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(PACKAGE, 'build');

const argv = process.argv.slice(2);
// Свои здесь только имя приложения (первый аргумент без дефиса) и `--stage`;
// всё остальное уезжает упаковщику как есть — включая значения флагов без `=`
// (`--linux dir`), которые фильтр «только с дефисом» молча терял бы.
const appIndex = argv.findIndex((arg) => !arg.startsWith('-'));
const app = appIndex === -1 ? 'game' : argv[appIndex];
const stageOnly = argv.includes('--stage');
const passthrough = argv.filter((arg, index) => index !== appIndex && arg !== '--stage');

const manifestPath = join(PACKAGE, 'apps', `${app}.app.json`);
if (!existsSync(manifestPath)) {
  console.error(`профиля "${app}" нет: ${manifestPath}`);
  process.exit(2);
}
const profile = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bundle = resolve(dirname(manifestPath), profile.bundle);
if (!existsSync(bundle)) {
  console.error(`бандл не собран: ${bundle}`);
  console.error('editor: npm run build:desktop -w @fluxus/editor-ui');
  console.error('game:   npm run demo:build:desktop -w @fluxus/demo');
  process.exit(2);
}

const staged = join(BUILD, app);
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });

// Контейнер целиком: bridge и host — исходники, которые грузит entry; клей —
// главный процесс и preload. Тестов и профилей других приложений здесь нет.
cpSync(join(PACKAGE, 'src'), join(staged, 'src'), { recursive: true });
cpSync(bundle, join(staged, 'bundle'), { recursive: true });

const roots = profile.roots.map((root) => {
  const from = resolve(dirname(manifestPath), root.directory);
  cpSync(from, join(staged, root.id), { recursive: true });
  return { ...root, directory: `./${root.id}` };
});
writeFileSync(
  join(staged, 'profile.app.json'),
  `${JSON.stringify({ ...profile, bundle: './bundle', roots }, null, 2)}\n`,
);

const own = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8'));
writeFileSync(
  join(staged, 'package.json'),
  `${JSON.stringify(
    {
      name: `fluxus-${app}`,
      productName: profile.title,
      version: own.version,
      description: `${profile.title} — десктоп-сборка (desktop-shell)`,
      author: 'Fluxus',
      private: true,
      type: 'module',
      // Профиль передаётся аргументом самому себе: контейнер без профиля не
      // запускается вовсе (DSK-5), и дистрибутив обязан его назвать.
      main: 'src/electron/entry.mjs',
      fluxus: { app: './profile.app.json' },
    },
    null,
    2,
  )}\n`,
);

console.error(`[${app}] разложено: ${staged}`);
if (stageOnly) process.exit(0);

const builder = createRequire(import.meta.url).resolve('electron-builder/out/cli/cli.js');
const result = spawnSync(process.execPath, [builder, '--config', join(PACKAGE, 'electron-builder.cjs'), ...passthrough], {
  cwd: PACKAGE,
  stdio: 'inherit',
  env: { ...process.env, FLUXUS_APP: app },
});
process.exit(result.status ?? 1);
