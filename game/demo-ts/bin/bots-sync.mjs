#!/usr/bin/env node
/**
 * Генерация записей способностей бот-профиля из сцены и её бот-аннотации
 * (BOT-13):
 *
 *   npm run bots:sync -- [--root content] [--profile bots/normal.json]
 *                        [--add] [--dry-run]
 *
 * Значение флага принимается обеими формами — `--root=content` и `--root
 * content` (CLI-11, `@game-mvp/net/bin/matchFile.mjs`).
 *
 * Команда запускается дизайнером РУКАМИ: сцена получила новое определение
 * способности, аннотация его описала — и запись профиля рождается из двух
 * документов, а не набирается по памяти. Гейтом при этом остаётся сверка
 * (`test/botContract.test.ts`, входит в `npm run check`): генерация предлагает,
 * а краснеет тест.
 *
 * Что команда пишет и чего не трогает, решает ОДИН модуль правил
 * (`app/botContract.ts`) — тот же, которым сверяет тест: второй реализации
 * правил вывода быть не должно (BOT-13). Числа сложности исполнения — шум
 * прицела, задержки подтверждений, вероятность отмены, вес, дальность,
 * длительность удержания и собственный темп применения — остаются профилем
 * (BOT-6) и правятся ТОЛЬКО человеком: разошедшееся со сценой число команда
 * называет находкой и выходит ненулевым кодом, а не переписывает его.
 *
 * Заведение записи, которой в профиле нет, включается явно (`--add`), и это не
 * осторожность, а разрез BOT-6: «в профиле этой способности нет» означает либо
 * «сцена только что её получила», либо «этот уровень сложности ею не играет», и
 * различить их команде нечем. По умолчанию она приводит к сцене то, что дизайнер
 * уже завёл, — прогон по отгруженному дереву обязан быть неподвижной точкой
 * (тест `botsSync.test.ts`).
 *
 * Живёт команда в сборке игры, а не в пакете движка, по той же причине, что и
 * стенд демо-арены: она читает дерево контента (`game-content` CONT-4), а игре
 * это законно — она и есть игра (CONT-1).
 *
 * Идемпотентность несущая: второй запуск подряд не меняет ни байта. Файл, у
 * которого правок нет, не переписывается вовсе; ПЕРЕПИСАННЫЙ печатается
 * читаемым сериализатором ядра (`prettyJsonSerializer`, `serialization` SER-2)
 * целиком — то есть первая же правка переформатирует рукописную вёрстку
 * профиля, и дифф будет на весь файл, а не на правку.
 *
 * Шага сборки нет по той же причине, что у запускалок: типы Node стрипает сам
 * (>=22.18), а хук резолва `./x.js` → `./x.ts` приезжает вместе с разбором
 * флагов.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Ради побочного действия (хук резолва) и ради разбора флагов обеих форм.
import { flag, option } from '@game-mvp/net/bin/matchFile.mjs';

const USAGE =
  'usage: npm run bots:sync -- [--root content] [--profile bots/normal.json] [--add] [--dry-run]\n' +
  '  --root     корень дерева контента (по умолчанию content/ репозитория)\n' +
  '  --profile  ограничить одним профилем; путь ОТ КОРНЯ дерева, как в документе аннотаций\n' +
  '  --add      заводить записи для способностей, которых в профиле нет:\n' +
  '             состав способностей бота — выбор дизайнера (BOT-6), поэтому только явным флагом\n' +
  '  --dry-run  ничего не писать, только назвать правки\n';

if (flag('help')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const { parseBotProfile } = await import('@game-mvp/bot');
const { prettyJsonSerializer } = await import('@game-mvp/core');
const { BOT_HINTS_SUFFIX, parseBotHints } = await import('../app/botHints.ts');
const { expectedAbilities, syncProfileAbilities, verifyProfileAbilities } = await import(
  '../app/botContract.ts'
);

// Умолчание корня — дерево контента РЕПОЗИТОРИЯ, а не `content/` рядом с
// рабочим каталогом: команда запускается и из корня (`npm run bots:sync`), и из
// пакета (`npm run bots:sync -w @game-mvp/demo`), и второй запуск не обязан
// падать ENOENT'ом. Тот же приём, что у стенда демо-арены (`demo-serve.mjs`).
// Явный `--root` резолвится от рабочего каталога — его называет человек.
const REPO_CONTENT = fileURLToPath(new URL('../../../content', import.meta.url));
const named = option('root');
const root = named === undefined ? REPO_CONTENT : resolve(process.cwd(), named);
const only = option('profile');
const add = flag('add');
const dryRun = flag('dry-run');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const say = (line) => process.stdout.write(`${line}\n`);

let failed = false;
let written = 0;
let visited = 0;

/** Один профиль: проверить, привести к сцене и записать, если правки есть. */
function syncProfile(expected, contentPath) {
  const file = join(root, contentPath);
  const document = readJson(file);
  // Проверка ДО правки: чинить чужие находки генерацией нельзя — документ
  // прошлой формы она бы молча переписала в текущую (BOT-6).
  const profile = parseBotProfile(document, contentPath);
  const before = JSON.stringify(document);
  const changes = syncProfileAbilities(expected, document, profile, { add });
  // И ПОСЛЕ: сгенерированное обязано быть валидным профилем, иначе команда
  // оставила бы на диске документ, который бот не примет. Он же и сверяется —
  // тем же кодом, что гейт: остаток находок это ровно то, что генерация трогать
  // не вправе (числа сложности, BOT-6), и чинит их дизайнер.
  const findings = verifyProfileAbilities(expected, parseBotProfile(document, contentPath));

  if (before === JSON.stringify(document)) {
    say(`${contentPath}: без изменений`);
  } else {
    for (const change of changes) say(`  ${change}`);
    if (dryRun) {
      say(`${contentPath}: ${changes.length} правк(и) — не записаны (--dry-run)`);
    } else {
      writeFileSync(file, prettyJsonSerializer.encode(document));
      written += 1;
      say(`${contentPath}: ${changes.length} правк(и) записаны`);
    }
  }

  if (findings.length === 0) return;
  // Находка — не отказ команды, а работа, оставшаяся человеку: правки записаны,
  // а число, которое генерации не принадлежит, названо. Ненулевой код нужен,
  // чтобы «почти сошлось» не выглядело как «сошлось».
  for (const finding of findings) say(`  находка: ${contentPath}: ${finding}`);
  say(`${contentPath}: ${findings.length} находк(и) — это числа профиля, правит их дизайнер (BOT-6)`);
  failed = true;
}

/** Одна пара «документ бот-аннотаций → парная сцена» дерева контента. */
function syncPair(name) {
  const base = name.slice(0, -BOT_HINTS_SUFFIX.length);
  const hints = parseBotHints(readJson(join(root, 'scenes', name)), `scenes/${name}`);
  // Парность — по имени файла, как у документа презентации (PRES-1).
  const scene = readJson(join(root, 'scenes', `${base}.scene.json`));
  const derived = expectedAbilities(scene, hints);
  // «Аннотация назвала этот профиль» — факт ДОКУМЕНТА, и считается он раньше
  // любых находок: иначе пара, отвалившаяся на находке вывода, выглядела бы как
  // опечатка в `--profile`, и дизайнера отправляли бы искать ошибку, которой он
  // не делал.
  const targets = hints.profiles.filter((path) => only === undefined || only === path);
  visited += targets.length;
  if (derived.findings.length > 0) {
    for (const finding of derived.findings) process.stderr.write(`${finding}\n`);
    failed = true;
    return;
  }
  for (const contentPath of targets) syncProfile(derived.abilities, contentPath);
}

try {
  const documents = readdirSync(join(root, 'scenes'))
    .filter((name) => name.endsWith(BOT_HINTS_SUFFIX))
    .sort();
  if (documents.length === 0) {
    say(`бот-аннотаций (*${BOT_HINTS_SUFFIX}) в ${join(root, 'scenes')} нет — синхронизировать нечего`);
  }
  for (const name of documents) syncPair(name);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

// Опечатка в `--profile` иначе выглядела бы как «всё уже сходится»: команда
// прошла бы по пустому списку и промолчала.
if (only !== undefined && visited === 0) {
  process.stderr.write(`профиль "${only}" не назван ни одним документом бот-аннотаций дерева\n`);
  process.exit(2);
}
if (failed) process.exit(2);
if (!dryRun && written === 0) say('дерево уже сходится со сценой');
