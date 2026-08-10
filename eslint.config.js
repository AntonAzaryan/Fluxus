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
 * Набор — strict-type-checked + stylistic-type-checked. Stylistic здесь — не
 * форматирование (отступы по-прежнему не предмет линта), а согласованность
 * конструкций: `interface` против `type`, `??` против `||`, `for-of` против
 * индексного цикла. Плюс метрики размера (`max-lines`, `max-depth`,
 * когнитивная сложность) — они ловят рост, который ревью замечает поздно.
 *
 * Детерминизм ядра (запрет Date/performance/таймеров/float-литералов и
 * неотносительных импортов в `engine/core-ts/src`) линтер сознательно НЕ
 * дублирует: это уже строже покрыто AST-сканером `engine/tests/guard/` и
 * архитектурными правилами dependency-cruiser (`npm run lint:arch`).
 *
 * Существующие нарушения новых правил заглушены как baseline — список и
 * порядок разгребания в `LINT_BASELINE.md`.
 */
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
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
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    plugins: { sonarjs },
    languageOptions: {
      parserOptions: {
        // `vitest.coverage.config.ts` — единственный `.ts` в корне, вне всех
        // пакетных tsconfig: сводный прогон покрытия задаётся флагом, а не
        // членством в workspace. `allowDefaultProject` даёт ему типизированный
        // разбор без отдельного tsconfig ради одного файла.
        projectService: {
          allowDefaultProject: ['vitest.coverage.config.ts'],
          // Строгие type-aware правила требуют strictNullChecks и для
          // default-project файлов — опции берутся из этого tsconfig.
          defaultProject: 'tsconfig.eslint.json',
        },
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
      /**
       * Метрики размера: файл, вложенность, когнитивная сложность. Не «стиль»,
       * а ранний сигнал, что модуль пора делить, — до того, как это станет
       * видно только по больному диффу.
       */
      'sonarjs/cognitive-complexity': ['error', 15],
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 4],
    },
  },

  /**
   * Тесты, скрипты, бины и демо: метрики размера и строгости данных здесь не
   * применимы — длинный табличный тест или fixture-генератор читается лучше,
   * чем искусственно нарезанный. Правила корректности (промисы, `any`,
   * недостижимые ветки) остаются в силе.
   */
  {
    files: [
      '**/test/**/*.ts',
      '**/*.test.ts',
      '**/bin/*.mjs',
      'scripts/**',
      'engine/client-ts/demo/**',
      'tools/blender-ts/test/**',
    ],
    rules: {
      'max-lines': 'off',
      'max-depth': 'off',
      'sonarjs/cognitive-complexity': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
    },
  },

  // TODO baseline: правила с массовыми существующими нарушениями временно
  // выключены вместо сотен точечных disable-комментариев. Счётчики и порядок
  // разгребания — в `LINT_BASELINE.md`; включать обратно по одному, начиная
  // с `sonarjs/cognitive-complexity`.
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },

  // Браузерные пакеты: воркер, DOM, THREE. Node-глобалей у них нет.
  {
    files: [
      'engine/client-ts/**/*.ts',
      'engine/render-ts/**/*.ts',
      'engine/hud-ts/**/*.ts',
      'editor/ui-ts/**/*.ts',
    ],
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
      'scripts/*.mjs',
      '.claude/hooks/**',
      'engine/client-ts/demo/**/*.ts',
      '**/bench.test.ts',
    ],
    rules: { 'no-console': 'off' },
  },
]);
