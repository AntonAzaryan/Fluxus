#!/usr/bin/env node
/**
 * Точка входа команды импорта (BLND-5): `npm run import -- <путь к .glb>` из
 * корня репозитория. Разбор аргументов и сам импорт — в `src/cli.ts`; здесь
 * только запуск.
 *
 * Шага сборки нет, как и у CLI ядра (`engine/core-ts/bin/sim.mjs`): типы Node
 * стрипает сам (>=22.18), а хуки резолва добавляют то, чего ему не хватает.
 * Хуков два, и оба — про то, как исходники репозитория написаны для tsc:
 *
 * 1. Импорты вида `./x.js` ведут на `./x.ts`.
 * 2. Импорт JSON без `with { type: 'json' }` — форма `resolveJsonModule`
 *    компилятора; Node требует атрибут, и хук проставляет его при резолве.
 *    Бандлы строковых ресурсов редактора едут именно так.
 *
 * Альтернатива — компилировать пакеты в dist перед каждым запуском инструмента,
 * который зовут из тестов и из аддона.
 */
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try {
        return next(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        // Настоящего .ts нет — резолвим как просили.
      }
    }
    if (specifier.endsWith('.json')) {
      return { ...next(specifier, context), importAttributes: { type: 'json' } };
    }
    return next(specifier, context);
  },
});

const { main } = await import('../src/cli.ts');

process.exitCode = await main(process.argv.slice(2), process.cwd(), {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
});
