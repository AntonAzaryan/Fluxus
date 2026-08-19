// Общий словарь гардов: какие пути защищены и почему. Правила — данные этого
// файла, их правка обязана попадать в дифф на ревью (тот же приём, что CLI-8
// задаёт для инвариантов детерминизма). Потребителя два: guard-generated.mjs
// (PreToolUse на Edit|Write) проверяет file_path правки, guard-bash.mjs
// (PreToolUse на Bash) ищет те же пути в shell-команде — один словарь, чтобы
// сообщения и покрытие не разъезжались.
import { readFileSync } from 'node:fs';

/**
 * Защищённые пути. `decision` — вердикт PreToolUse: deny режет операцию,
 * ask отдаёт решение человеку.
 */
export const PATH_RULES = [
  {
    pattern: /(^|\/)engine\/schemas\/[^/]+\.json$/,
    decision: 'deny',
    reason:
      'engine/schemas/*.json генерируются из ядра — руками не редактируются. Меняй схемы в core-ts и регенерируй: npm run schemas (из engine/core-ts).',
  },
  {
    pattern: /(^|\/)engine\/tests\/golden\/[^/]+\.golden\.json$/,
    decision: 'deny',
    reason:
      'Golden-эталоны и match-сценарии пишутся только прогоном: npm run golden из корня репозитория (скил golden-update). Ручная правка — фальсификация эталона.',
  },
  {
    pattern: /(^|\/)engine\/tests\/golden\/match-[^/]+\.scenario\.json$/,
    decision: 'deny',
    reason:
      'Golden-эталоны и match-сценарии пишутся только прогоном: npm run golden из корня репозитория (скил golden-update). Ручная правка — фальсификация эталона.',
  },
  {
    pattern: /(^|\/)engine\/tests\/golden\/[^/]+\.cost\.json$/,
    decision: 'deny',
    reason:
      'Cost-эталоны (*.cost.json) регенерируются только через npm run golden:cost из корня — принятие изменения стоимости это отдельное осознанное решение (performance-budget PERF-3/PERF-4). Ручная правка — фальсификация эталона.',
  },
  {
    pattern: /(^|\/)openspec\/specs\//,
    decision: 'ask',
    reason:
      'openspec/specs/ меняется через opsx-цикл (/opsx:apply, /opsx:sync, /opsx:archive). Подтверди, что это шаг этого цикла, а не прямая правка спеки.',
  },
];

/** Первое правило, под которое попадает путь (прямые слэши), либо null. */
export function ruleForPath(path) {
  const normalized = String(path).replaceAll('\\', '/');
  return PATH_RULES.find((rule) => rule.pattern.test(normalized)) ?? null;
}

/** Прочитать JSON-вход хука со stdin. */
export function readHookInput() {
  return JSON.parse(readFileSync(0, 'utf8'));
}

/** Выдать вердикт PreToolUse и завершиться. */
export function emitPreToolUseDecision(permissionDecision, permissionDecisionReason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason },
    }),
  );
  process.exit(0);
}
