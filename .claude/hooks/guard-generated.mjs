#!/usr/bin/env node
// PreToolUse-гард на генерируемое и нормативное (Edit|Write|NotebookEdit).
// Правки руками сюда ломают контракт «источник истины»:
//  - engine/schemas/*.json порождаются из ядра (npm run schemas) — deny;
//  - golden-эталоны и записанные match-сценарии пишутся только прогоном
//    (npm run golden из корня репозитория) — deny;
//  - cost-эталоны (*.cost.json) — только npm run golden:cost — deny;
//  - openspec/specs/** меняются в рамках opsx-цикла — ask: правка
//    легитимна внутри /opsx:apply|sync|archive, подтверждает человек;
//  - engine/core-ts/package.json не получает runtime-зависимостей — deny.
// Сами правила путей — в guardRules.mjs, общем с guard-bash.mjs.
import { emitPreToolUseDecision, readHookInput, ruleForPath } from './guardRules.mjs';

const input = readHookInput();
const file = String(input.tool_input?.file_path ?? '').replaceAll('\\', '/');

const rule = ruleForPath(file);
if (rule) emitPreToolUseDecision(rule.decision, rule.reason);

// Ноль runtime-зависимостей ядра: секция dependencies в engine/core-ts/package.json
// не появляется вовсе (сегодня её там нет), devDependencies — свободны.
if (/(^|\/)engine\/core-ts\/package\.json$/.test(file)) {
  const added = String(input.tool_input?.new_string ?? input.tool_input?.content ?? '');
  const removed = String(input.tool_input?.old_string ?? '');
  const mentionsDeps = (text) => /"dependencies"\s*:/.test(text);
  if (mentionsDeps(added) && !mentionsDeps(removed)) {
    emitPreToolUseDecision(
      'deny',
      'У ядра ноль runtime-зависимостей — секция dependencies в engine/core-ts/package.json не появляется (ECS-библиотеки и json-logic-js отклонены сознательно). Dev-зависимость ставь в devDependencies.',
    );
  }
}

process.exit(0);
