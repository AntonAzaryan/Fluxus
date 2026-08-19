#!/usr/bin/env node
// PreToolUse-гард на Bash: ловит shell-обход файловых гардов guard-generated.mjs
// (sed -i, редирект, mv/rm/tee по защищённым путям — словарь общий,
// guardRules.mjs) и установку runtime-зависимости в ядро (npm i <pkg> в
// engine/core-ts без -D): у ядра ноль runtime-зависимостей.
//
// Это эвристика по тексту команды, а не парсер bash: она обязана не мешать
// чтению (cat/grep/diff по эталонам легальны) и потому режет только команды,
// где защищённый путь стоит в позиции записи.
import { emitPreToolUseDecision, readHookInput, ruleForPath } from './guardRules.mjs';

const input = readHookInput();
const command = String(input.tool_input?.command ?? '');
const sessionCwd = String(input.cwd ?? '').replaceAll('\\', '/');

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Токены-кандидаты в пути: всё между пробелами, кавычками и метасимволами shell. */
const pathTokens = (segment) =>
  (segment.match(/[^\s'"`;|&()<>]+/g) ?? []).map((token) =>
    token.replaceAll('\\', '/').replace(/[,:]+$/, ''),
  );

/** Команды, при которых само упоминание защищённого пути — уже запись/утрата. */
const DESTRUCTIVE_ANYWHERE = /(^|\s)(rm|mv|truncate|shred|unlink)(\s|$)|\btee\b|\b(writeFileSync|appendFileSync|createWriteStream|writeFile)\b/;

/** Пишет ли сегмент команды в файл token. */
function segmentWritesTo(segment, token) {
  if (DESTRUCTIVE_ANYWHERE.test(segment)) return true;
  if (/\b(sed|perl)\b/.test(segment) && /\s-i\b/.test(segment)) return true;
  // Редирект или dd of= прямо в защищённый путь.
  if (new RegExp(`(>{1,2}|\\bof=)\\s*['"\`]?${escapeRegExp(token)}`).test(segment)) return true;
  // cp/install пишут в последний аргумент-путь.
  if (/(^|\s)(cp|install)\s/.test(segment)) {
    const paths = pathTokens(segment).filter((t) => t.includes('/'));
    if (paths.at(-1) === token) return true;
  }
  return false;
}

// Сегменты конвейера: внутри одного сегмента путь и глагол записи связаны,
// между сегментами — нет (cat эталона | jq > /tmp/x — чтение).
const segments = command.split(/&&|\|\||;|\||\n/);

for (const segment of segments) {
  for (const token of pathTokens(segment)) {
    const rule = ruleForPath(token);
    if (rule && segmentWritesTo(segment, token)) {
      emitPreToolUseDecision(rule.decision, `Команда выглядит как запись в защищённый файл (${token}). ${rule.reason}`);
    }
  }
}

// npm install runtime-зависимости в ядро. Учитываем и явный -w/--workspace,
// и текущую директорию сессии/цепочку cd внутри команды.
const isCoreDir = (dir) => /(^|\/)engine\/core-ts\/?$/.test(dir);
let effectiveDir = sessionCwd;
for (const segment of segments) {
  const cd = /^\s*cd\s+(\S+)/.exec(segment);
  if (cd) {
    const target = cd[1].replaceAll('\\', '/');
    effectiveDir = target.startsWith('/') ? target : `${effectiveDir}/${target}`;
    continue;
  }
  const install = /(?:^|\s)npm\s+(?:i|install|add)\b(.*)$/.exec(segment);
  if (!install) continue;

  const rest = install[1].trim().split(/\s+/).filter(Boolean);
  const packages = [];
  let workspace = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '-w' || arg === '--workspace') {
      workspace = rest[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('-w=') || arg.startsWith('--workspace=')) {
      workspace = arg.slice(arg.indexOf('=') + 1);
    } else if (!arg.startsWith('-')) {
      packages.push(arg);
    }
  }
  const workspaceIsCore =
    workspace != null && (workspace === '@game-mvp/core' || isCoreDir(workspace.replaceAll('\\', '/')));
  const targetsCore = workspaceIsCore || (workspace == null && isCoreDir(effectiveDir));
  const isDev = /(^|\s)(-D|--save-dev)(\s|$)/.test(segment);
  if (targetsCore && packages.length > 0 && !isDev) {
    emitPreToolUseDecision(
      'deny',
      `Установка runtime-зависимости в ядро (${packages.join(', ')}): у engine/core-ts ноль runtime-зависимостей, ECS-библиотеки и json-logic-js отклонены сознательно. Dev-инструмент ставь с -D, runtime-библиотеку — не ставь.`,
    );
  }
}

process.exit(0);
