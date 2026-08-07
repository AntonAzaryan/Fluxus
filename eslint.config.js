/**
 * Конфигурация линтера — одна на весь workspace.
 *
 * Одна, а не по конфигу на пакет, по той же причине, по какой одна на весь
 * репозиторий сборка тестов: правила здесь — репозиторные, а не про отдельный
 * слой. Пакетные отличия (DOM против Node, генерируемые файлы) выражены
 * секциями `files`, а не отдельными файлами конфигурации, которые разъезжаются.
 *
 * Линтер не дублирует `tsc`. Всё, что ловит компилятор, ловится `npm run
 * typecheck`; здесь — то, чего компилятор не видит: непрочитанный промис,
 * лишний `await`, сравнение с `any`, недостижимая ветка. Поэтому набор —
 * type-checked: без типов половина этих правил не работает.
 *
 * Стилевых правил нет намеренно. Форматирование — не предмет спора в
 * репозитории с одним автором, а расстановка отступов линтером даёт шум в
 * дифах ровно там, где ревью читает смысл.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Правила, не требующие типов, — общие для `.ts` и для CLI-бинов на `.mjs`. */
const untypedRules = {
  'no-console': ['error', { allow: ['error', 'warn'] }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'prefer-const': 'error',
  'no-var': 'error',
};

export default defineConfig([
  // Артефакты и контент: генерируемые схемы правит `npm run schemas`, эталоны —
  // `npm run golden`, контент — геймдизайнер. Линтеру там нечего сказать, а
  // красный линт на сгенерированном файле обесценивает линт.
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    'engine/schemas/**',
    'engine/tests/golden/**',
    'content/**',
    'openspec/**',
  ]),

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    // Типизированный линт — только там, где есть tsconfig, то есть на `.ts`.
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // `vitest.coverage.config.ts` — единственный `.ts` в корне, вне всех
        // пакетных tsconfig: сводный прогон покрытия задаётся флагом, а не
        // членством в workspace. `allowDefaultProject` даёт ему типизированный
        // разбор без отдельного tsconfig ради одного файла.
        projectService: { allowDefaultProject: ['vitest.coverage.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...untypedRules,
      /**
       * Неиспользованное имя — ошибка, но `_`-префикс освобождает: подпись,
       * навязанную интерфейсом, переименовывать в угоду линтеру нельзя.
       */
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      /** Брошенный промис в тике — то, что тесты не видят, а рантайм проглотит. */
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },

  // Браузерные пакеты: воркер, DOM, THREE. Node-глобалей у них нет.
  {
    files: ['engine/client-ts/**/*.ts', 'engine/render-ts/**/*.ts', 'editor/ui-ts/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
  {
    files: [
      'engine/core-ts/**/*.ts',
      'engine/net-ts/**/*.ts',
      'engine/assets-ts/**/*.ts',
      'editor/core-ts/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['engine/integration-ts/**/*.ts', 'engine/tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  /**
   * CLI-бины на `.mjs`: в tsconfig они не входят (пакеты включают только `src` и
   * `test`), поэтому типизированных правил для них нет — только базовые. Это
   * ровно та зона, которую не видит `npm run typecheck`, так что даже базовый
   * набор здесь — прибавка, а не формальность.
   */
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
      ecmaVersion: 2023,
    },
    rules: untypedRules,
  },

  /**
   * Печать в stdout как интерфейс, а не отладочный след: у CLI-бинов и hook'ов
   * это единственный способ ответить, у демо — способ показать состояние без
   * UI, у замеров канала — сам результат (тест помечен «информативно» и ничего
   * не утверждает, кроме порядка величины).
   */
  {
    files: [
      '**/bin/*.mjs',
      '.claude/hooks/**',
      'engine/client-ts/demo/**/*.ts',
      '**/bench.test.ts',
    ],
    rules: { 'no-console': 'off' },
  },
]);
