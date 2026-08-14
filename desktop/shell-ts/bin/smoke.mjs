#!/usr/bin/env node
/**
 * Smoke-прогон контейнера — проверка вне гейта (DSK-6: «полный прогон в
 * контейнере — отдельная проверка вне `npm run check`»).
 *
 * Что он утверждает: контейнер поднимается с каждым профилем, страница
 * приложения грузится из раздачи, а поверхность моста в странице совпадает с
 * whitelist профиля — ни больше (DSK-5), ни меньше.
 *
 * Чего он НЕ делает: не собирает бандлы приложений и не скачивает Electron.
 * И то и другое — предусловия, и отсутствие каждого он называет вслух, а не
 * изображает провал контейнера:
 *
 *   npm run build -w @game-mvp/editor-ui      # бандл редактора
 *   npm run demo:build -w @game-mvp/client    # бандл демо игры
 *   npm install                               # с бинарём Electron
 *
 * Запуск: `npm run smoke -w @game-mvp/desktop-shell` (или `-- editor`, `-- game`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PACKAGE, 'src/electron/entry.mjs');
/** Ассет дерева, который страница просит по ID-пути (ASSET-2): проба раздачи. */
const PROBE = '/visuals/manifest.json';
/** Куда пишет сквозная проверка правки. Пишущий профиль — во временное дерево. */
const ROUNDTRIP = 'scenes/smoke.scene.json';

/** Путь к бинарю Electron; `null` — пакет есть, а бинаря нет (или нет и пакета). */
function electronBinary() {
  try {
    const path = createRequire(import.meta.url)('electron');
    return typeof path === 'string' && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/** Разбирает манифест профиля настолько, насколько нужно самому прогону. */
function profileOf(name) {
  const manifest = join(PACKAGE, 'apps', `${name}.app.json`);
  if (!existsSync(manifest)) throw new Error(`профиля "${name}" нет: ${manifest}`);
  const raw = JSON.parse(readFileSync(manifest, 'utf8'));
  return { name, manifest, bundle: resolve(dirname(manifest), raw.bundle), capabilities: raw.capabilities };
}

/**
 * Временное дерево контента для пишущего профиля: сквозная правка не трогает
 * `content/` репозитория — прогон обязан ничего за собой не оставлять.
 * Возвращает профиль-двойник с подменённым корнем.
 */
function temporaryTree(profile) {
  const workspace = mkdtempSync(join(tmpdir(), 'fluxus-smoke-'));
  const directory = join(workspace, 'content');
  mkdirSync(join(directory, 'visuals'), { recursive: true });
  mkdirSync(join(directory, 'scenes'), { recursive: true });
  writeFileSync(join(directory, PROBE.slice(1)), '{"entities":{}}\n');
  const raw = JSON.parse(readFileSync(profile.manifest, 'utf8'));
  raw.bundle = profile.bundle;
  raw.roots = raw.roots.map((root) => ({ ...root, directory }));
  const manifest = join(workspace, 'profile.app.json');
  writeFileSync(manifest, JSON.stringify(raw));
  return { ...profile, manifest, workspace, directory };
}

/** Один прогон: поднять контейнер, дождаться строки отчёта, сверить поверхность. */
function run(binary, profile) {
  return new Promise((done) => {
    // Под root Chromium отказывается стартовать со своей песочницей, а прогон
    // в контейнере CI обычно идёт именно под root. Флаг снимает песочницу
    // ПРОЦЕССА и не трогает `sandbox: true` окна — изоляция контекста и запрет
    // Node в странице остаются теми же (DSK-5).
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    // Программный WebGL: на машине без GPU (xvfb, CI) без него страница
    // поднимается, но рендер жалуется на контекст. Это свойство окружения, а
    // не контейнера, и просить у прогона настоящую видеокарту незачем.
    const software = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    const child = spawn(
      binary,
      [
        ENTRY,
        ...(asRoot ? ['--no-sandbox'] : []),
        ...software,
        '--app',
        profile.manifest,
        '--smoke',
        '--probe',
        PROBE,
        ...(profile.workspace === undefined ? [] : ['--roundtrip', ROUNDTRIP]),
      ],
      {
        cwd: PACKAGE,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (error) => {
      done({ ok: false, why: `контейнер не запустился: ${error.message}` });
    });
    child.on('close', () => {
      const line = out.split('\n').find((text) => text.startsWith('SMOKE '));
      if (line === undefined) {
        done({ ok: false, why: `отчёта не пришло; stderr:\n${err.trim()}` });
        return;
      }
      const { seen, complaints } = JSON.parse(line.slice('SMOKE '.length));
      if (seen.bridge !== true) {
        done({ ok: false, why: 'моста в странице нет вовсе' });
        return;
      }
      const declared = [...profile.capabilities].sort().join(',');
      const got = [...seen.capabilities].sort().join(',');
      if (declared !== got) {
        done({ ok: false, why: `сессия объявила [${got}], профиль — [${declared}]` });
        return;
      }
      // Поверхность обязана соответствовать возможностям: лишний метод — это
      // возможность, которой профиль не давал (DSK-5).
      const expected = new Set();
      if (seen.capabilities.includes('read')) for (const n of ['read', 'stat', 'list']) expected.add(n);
      if (seen.capabilities.includes('write')) expected.add('write');
      if (seen.capabilities.includes('watch')) expected.add('watch');
      if (seen.capabilities.includes('dialog')) expected.add('choose');
      if (seen.capabilities.includes('window')) {
        for (const n of ['setTitle', 'setUnsaved', 'onCloseRequest']) expected.add(n);
      }
      const surface = [...seen.surface].sort().join(',');
      const wanted = [...expected].sort().join(',');
      if (surface !== wanted) {
        done({ ok: false, why: `поверхность моста [${surface}], а по возможностям ждали [${wanted}]` });
        return;
      }
      if (seen.roots.some((root) => root.base === '')) {
        done({ ok: false, why: 'базовый адрес раздачи странице не сообщён (DSK-4)' });
        return;
      }
      // Ассет дерева, запрошенный страницей обычным `fetch` по ID-пути: то
      // самое «код загрузки клиента не отличается от браузерного» (DSK-4).
      if (seen.probe?.status !== 200 || seen.probe.bytes === 0) {
        done({ ok: false, why: `ассет "${PROBE}" страницей не получен: ${JSON.stringify(seen.probe)}` });
        return;
      }
      // Сквозная правка: страница записала документ мостом, прочитала его
      // обратно, а на диске лежат ровно те же байты (ED-21, DSK-2).
      if (profile.workspace !== undefined) {
        if (seen.trip === null || seen.trip === undefined) {
          done({ ok: false, why: 'сквозной правки не случилось: моста записи в странице нет' });
          return;
        }
        const onDisk = readFileSync(join(profile.directory, ROUNDTRIP), 'utf8');
        if (!seen.trip.same || onDisk !== seen.trip.text) {
          done({ ok: false, why: `байты разошлись: страница ${JSON.stringify(seen.trip)}, диск ${JSON.stringify(onDisk)}` });
          return;
        }
      }
      if (complaints.length > 0) {
        done({ ok: false, why: `страница жалуется: ${complaints.slice(0, 3).join(' | ')}` });
        return;
      }
      done({
        ok: true,
        why:
          `мост [${got || 'пуст'}], база ${seen.roots[0]?.base ?? '—'}, ассет ${seen.probe.bytes} Б, ` +
          `Worker ${seen.workers}${profile.workspace === undefined ? '' : ', сквозная правка сошлась побайтно'}`,
      });
    });
  });
}

const asked = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const names = asked.length > 0 ? asked : ['editor', 'game'];
const binary = electronBinary();
if (binary === null) {
  console.error('Electron не установлен (нет бинаря): `npm install` без ELECTRON_SKIP_BINARY_DOWNLOAD.');
  console.error('Гейт `npm run check` это не затрагивает — он не требует контейнера (DSK-6).');
  process.exit(2);
}

let failed = 0;
for (const name of names) {
  const profile = profileOf(name);
  if (!existsSync(profile.bundle)) {
    console.error(`[${name}] бандл не собран: ${profile.bundle} — см. шапку скрипта`);
    failed += 1;
    continue;
  }
  // Пишущий профиль правит дерево, поэтому правит он временное: прогон не
  // оставляет следов в `content/` репозитория.
  const target = profile.capabilities.includes('write') ? temporaryTree(profile) : profile;
  try {
    const result = await run(binary, target);
    console.error(`[${name}] ${result.ok ? 'ок' : 'ОТКАЗ'}: ${result.why}`);
    if (!result.ok) failed += 1;
  } finally {
    if (target.workspace !== undefined) rmSync(target.workspace, { recursive: true, force: true });
  }
}
process.exit(failed === 0 ? 0 : 1);
