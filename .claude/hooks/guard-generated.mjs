#!/usr/bin/env node
// PreToolUse-гард на генерируемое и нормативное. Правки руками сюда ломают
// контракт «источник истины»:
//  - engine/schemas/*.json порождаются из ядра (npm run schemas) — deny;
//  - golden-эталоны и записанные match-сценарии пишутся только прогоном
//    (npm run golden из engine/) — deny;
//  - engine/openspec/specs/** меняются в рамках opsx-цикла — ask: правка
//    легитимна внутри /opsx:apply|sync|archive, подтверждает человек.
import { readFileSync } from 'node:fs';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = String(input.tool_input?.file_path ?? '').replaceAll('\\', '/');

const decide = (permissionDecision, permissionDecisionReason) => {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
    }),
  );
  process.exit(0);
};

if (/(^|\/)engine\/schemas\/[^/]+\.json$/.test(file)) {
  decide(
    'deny',
    'engine/schemas/*.json генерируются из ядра — руками не редактируются. Меняй схемы в core-ts и регенерируй: npm run schemas (из engine/core-ts).',
  );
}

if (
  /(^|\/)engine\/tests\/golden\/[^/]+\.golden\.json$/.test(file) ||
  /(^|\/)engine\/tests\/golden\/match-[^/]+\.scenario\.json$/.test(file)
) {
  decide(
    'deny',
    'Golden-эталоны и match-сценарии пишутся только прогоном: npm run golden из engine/ (скил golden-update). Ручная правка — фальсификация эталона.',
  );
}

if (/(^|\/)engine\/openspec\/specs\//.test(file)) {
  decide(
    'ask',
    'engine/openspec/specs/ меняется через opsx-цикл (/opsx:apply, /opsx:sync, /opsx:archive). Подтверди, что это шаг этого цикла, а не прямая правка спеки.',
  );
}

process.exit(0);
