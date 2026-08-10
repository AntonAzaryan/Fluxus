# Lint baseline

Состояние на момент внедрения статического анализа (2026-08-10). Всё
перечисленное — временно заглушенные существующие нарушения, не оценка
допустимости. Разгребать сверху вниз; после разгребания пункта — убрать
заглушку и вычеркнуть отсюда.

## 1. tsconfig: `exactOptionalPropertyTypes` — выключен

Единственный из требуемых строгих флагов, не включённый: даёт **60 ошибок**
(порог включения — 30). `noFallthroughCasesInSwitch` и `noImplicitOverride`
включены во все 10 tsconfig без единой ошибки.

Разбивка по пакетам: editor-ui 17, client 9, integration 9, render 8, core 7,
editor-core 4, net 3, blender-ts 3, engine/tests 0.

Коды: TS2412 (присваивание `undefined` optional-полю) ×20, TS2345 (аргумент с
`undefined`) ×16, TS2375 (объектный литерал с явным `undefined`) ×13, TS2379
(getter/setter) ×11. Типовая правка — `field?: T` → `field?: T | undefined`
там, где `undefined` пишется явно, либо убрать явную запись `undefined`.

## 2. ESLint-правила, выключенные в блоке «TODO baseline» (`eslint.config.js`)

| Правило | Нарушений | Комментарий |
|---|---|---|
| `sonarjs/cognitive-complexity` (15) | 53 | Все в `src`. Самое ценное для разгребания: каждое — кандидат на декомпозицию. |
| `@typescript-eslint/no-non-null-assertion` | 357 | Все в `src`; в основном индексация TypedArray/SoA под `noUncheckedIndexedAccess`. Разгребать через локальные инварианты, не через слепые `?? fallback`. |
| `@typescript-eslint/restrict-template-expressions` | 392 | Числа/enum в шаблонных строках диагностик. Механическое, низкий риск. |

Включать по одному, начиная с `cognitive-complexity`.

## 3. knip: категории, выключенные в `knip.json` (`"rules"`)

| Категория | Находок | Комментарий |
|---|---|---|
| `exports` | 93 | Из них 84 — `editor/ui-ts` (операции/константы areas, экспортированные «на вырост»). |
| `types` | 21 | Аналогично, в основном editor/ui-ts и blender-ts. |
| `duplicates` | 1 | `msgpackSerializer` = `DEFAULT_SERIALIZER` в `engine/net-ts/src/protocol/codec.ts`. |

Плюс один ignore-файл: `scripts/spec-graph.d.mts` (рукописные типы к
`spec-graph.mjs`, кодом не импортируются — нужны LSP). Проверки `files`,
`dependencies`, `unlisted`, `unresolved` — активны.

## 4. Точечные `eslint-disable ... -- baseline` (59 файлов, 95 директив)

| Правило | Штук |
|---|---|
| `@typescript-eslint/prefer-optional-chain` | 23 |
| `@typescript-eslint/no-unnecessary-condition` | 22 |
| `max-lines` (file-level, 400 строк) | 19 |
| `@typescript-eslint/prefer-for-of` | 7 |
| `max-depth` (4) | 6 |
| `@typescript-eslint/no-empty-function` | 5 |
| `@typescript-eslint/no-misused-spread` | 3 |
| `@typescript-eslint/prefer-nullish-coalescing` | 2 |
| `@typescript-eslint/no-unnecessary-type-conversion` | 2 |
| `@typescript-eslint/no-deprecated` | 2 |
| прочие (`no-extraneous-class`, `no-invalid-void-type`, `no-confusing-void-expression`, `no-unnecessary-type-parameters`) | 4 |

Найти все: `grep -rn -- '-- baseline' engine editor tools`.

## 5. Послабления для тестов/скриптов (не баг, осознанная политика)

Блок в `eslint.config.js` для `**/test/**`, `**/*.test.ts`, `**/bin/*.mjs`,
`scripts/**`, демо и фикстур: выключены `max-lines`, `max-depth`,
`sonarjs/cognitive-complexity`, `no-non-null-assertion`, `no-magic-numbers`,
`no-empty-function`, `no-dynamic-delete`. Это не baseline — разгребать не надо.

## 6. Чисто без baseline

- **jscpd** (`lint:dup`): 0.98% дублирования при пороге 3% — прошёл сразу.
- **dependency-cruiser** (`lint:arch`): 0 нарушений на 497 модулях.
- ESLint-автофиксы (`--fix`) применены: ~590 нарушений (`dot-notation`,
  `no-confusing-void-expression`, `non-nullable-type-assertion-style` и др.)
  исправлены кодом, а не заглушены; typecheck и все тесты зелёные.

## Отступление от исходного ТЗ

`no-restricted-imports` / `no-restricted-globals` / `no-restricted-properties`
(запрет three/рендерера и `Math.random`/`Date.now`/таймеров в ядре) в ESLint
**не внедрены — осознанно, по решению при планировании**: эти инварианты уже
покрыты строже AST-сканером `engine/tests/guard/scanner.ts` (guard-тесты core
и net ловят в том числе float-литералы и любые неотносительные импорты) и
межпакетными правилами dependency-cruiser (`.dependency-cruiser.cjs`). Два
источника истины для одного инварианта иметь не хотим.
