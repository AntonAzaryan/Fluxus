#!/usr/bin/env node
// PostToolUse-советник (Edit|Write|NotebookEdit): мягкие предупреждения по
// правкам под engine/ — не блокирует, а возвращает Claude контекст через
// additionalContext. Две проверки:
//  - маркеры недетерминизма в engine/core-ts/src (wall-clock, таймеры, чужая
//    случайность, float-литералы, трансцендентный Math, async) — AST-гард
//    engine/tests/guard/scanner.ts поймает их только на npm test, хук говорит
//    сразу;
//  - fs-чтение дерева content/ из engine/** (CONT-4): depcruise-барьер
//    engine-no-content видит только import-рёбра, fs-чтения для него невидимы,
//    поэтому здесь единственное автоматическое напоминание.
import { readHookInput } from './guardRules.mjs';

const input = readHookInput();
const file = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '').replaceAll('\\', '/');
const added = String(
  input.tool_input?.new_string ?? input.tool_input?.content ?? input.tool_input?.new_source ?? '',
);

const notes = [];

// --- Детерминизм ядра: engine/core-ts/src/** ---
// Списки согласованы со сканером (engine/tests/guard/scanner.ts): Math,
// точный на целых, разрешён; остальное — трансцендентное и random — нет.
const MATH_ALLOWED = new Set(['min', 'max', 'abs', 'floor', 'ceil', 'trunc', 'imul', 'sign']);
const FORBIDDEN_GLOBALS = /\b(Date|performance|process|setTimeout|setInterval|setImmediate|queueMicrotask|crypto)\b/g;
const FLOAT_LITERAL = /(?<![\w.])\d+\.\d+|(?<![\w.])\d+[eE][+-]?\d+/;

if (/(^|\/)engine\/core-ts\/src\//.test(file)) {
  const markers = new Set();
  for (const match of added.matchAll(/\bMath\.(\w+)/g)) {
    if (!MATH_ALLOWED.has(match[1])) markers.add(`Math.${match[1]}`);
  }
  for (const match of added.matchAll(FORBIDDEN_GLOBALS)) markers.add(match[1]);
  if (FLOAT_LITERAL.test(added)) markers.add('float-литерал');
  if (/\basync\b|\bawait\b/.test(added)) markers.add('async/await');
  if (markers.size > 0) {
    notes.push(
      `Правка ${file} затронула маркеры недетерминизма: ${[...markers].join(', ')}. ` +
        'В ядре запрещены wall-clock, таймеры, случайность вне ГПСЧ, float-литералы и трансцендентный Math (DET-4, DET-5); ' +
        'AST-гард engine/tests/guard/scanner.ts сделает npm test красным. Если это легитимное исключение — оно объявляется в конфиге сканера ' +
        'и попадает в дифф; перед коммитом прогони скил determinism-review.',
    );
  }
}

// --- CONT-4: fs-чтение content/ из движка ---
// Два легальных долга описаны в CLAUDE.md и исключены; третьего не появляется.
const CONT4_DEBT = [
  /(^|\/)engine\/bot-ts\/test\/profile\.test\.ts$/,
  /(^|\/)engine\/integration-ts\/test\/presentationIsolation\.test\.ts$/,
];
const FS_READ = /\b(readFileSync|readFile|readdirSync|readdir|createReadStream|statSync|existsSync|globSync|opendirSync)\s*\(/;
const CONTENT_REF = /['"`](?:\.{1,2}\/)*content(?:\/|['"`])/;

if (
  /(^|\/)engine\//.test(file) &&
  !CONT4_DEBT.some((pattern) => pattern.test(file)) &&
  FS_READ.test(added) &&
  CONTENT_REF.test(added)
) {
  notes.push(
    `Правка ${file} добавляет fs-чтение пути в content/. CONT-4: движок не читает дерево контента — ` +
      'depcruise-барьер engine-no-content видит только import-рёбра, fs-чтения ему невидимы. Легальный долг ровно в двух местах ' +
      '(engine/bot-ts/test/profile.test.ts, engine/integration-ts/test/presentationIsolation.test.ts); третье чтение — шаг назад. ' +
      'Чтение контента — дело игры (game/demo-ts) или editor/*.',
  );
}

if (notes.length > 0) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n\n') },
    }),
  );
}

process.exit(0);
