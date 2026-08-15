# Lint baseline

Состояние на момент внедрения статического анализа (2026-08-10). Всё
перечисленное — временно заглушенные существующие нарушения, не оценка
допустимости. Разгребать сверху вниз; после разгребания пункта — убрать
заглушку и вычеркнуть отсюда.

**Последний замер: 2026-08-15.** Счётчики ниже пересняты целиком по методике,
описанной в каждом пункте; они справочные и стареют с каждым коммитом —
политику пунктов замер не меняет.

## 1. tsconfig: `exactOptionalPropertyTypes` — выключен

Единственный из требуемых строгих флагов, не включённый: даёт **116 ошибок**
(порог включения — 30). `noFallthroughCasesInSwitch` и `noImplicitOverride`
включены во все 14 tsconfig без единой ошибки.

Замер: `npx tsc --noEmit -p <пакет> --exactOptionalPropertyTypes` по каждому
tsconfig отдельно (флаг командной строки перебивает конфиг, файлы не трогаются).

Разбивка по пакетам: editor-ui 20, hud 13, integration 13, demo 13, client 12,
render 12, bot 11, core 8, editor-core 5, net 5, blender-ts 4, assets 0,
desktop-shell 0, engine/tests 0.

Коды: TS2412 (присваивание `undefined` optional-полю) ×42, TS2379
(getter/setter) ×34, TS2345 (аргумент с `undefined`) ×22, TS2375 (объектный
литерал с явным `undefined`) ×18. Типовая правка — `field?: T` →
`field?: T | undefined` там, где `undefined` пишется явно, либо убрать явную
запись `undefined`.

## 2. ESLint-правила, выключенные в блоке «TODO baseline» (`eslint.config.js`)

| Правило | Нарушений | Комментарий |
|---|---|---|
| `sonarjs/cognitive-complexity` (15) | 68 | Все в `src`. Самое ценное для разгребания: каждое — кандидат на декомпозицию. |
| `@typescript-eslint/no-non-null-assertion` | 593 | Все в `src`; в основном индексация TypedArray/SoA под `noUncheckedIndexedAccess`. Разгребать через локальные инварианты, не через слепые `?? fallback`. |
| `@typescript-eslint/restrict-template-expressions` | 355 | Числа/enum в шаблонных строках диагностик. Механическое, низкий риск. Считано по `src`; ещё 119 живут в тестах, бинах и `game/demo-ts/app/**` — послабления п.5 это правило не гасят. |

Замер: убрать три строки из блока «TODO baseline» в `eslint.config.js`,
прогнать `npx eslint . --format json` и посчитать сообщения по `ruleId` —
послабления п.5 при этом остаются в силе, поэтому колонка и есть «в `src`».

Включать по одному, начиная с `cognitive-complexity`.

## 3. knip: категории, выключенные в `knip.json` (`"rules"`)

| Категория | Находок | Комментарий |
|---|---|---|
| `exports` | 90 | Из них 67 — `editor/ui-ts` (операции/константы areas, экспортированные «на вырост»), 10 — blender-ts, 9 — editor-core. |
| `types` | 24 | Аналогично, в основном editor/ui-ts (16) и client-ts/blender-ts. |
| `duplicates` | 1 | `msgpackSerializer` = `DEFAULT_SERIALIZER` в `engine/net-ts/src/protocol/codec.ts`. **Не дефект, разгребать нечего:** это одно значение под двумя именами — `DEFAULT_SERIALIZER` стоит значением параметра по умолчанию, `msgpackSerializer` передают явно; используются оба. Категорию держим выключенной ради этой единственной находки. |

Замер: убрать блок `"rules"` из `knip.json`, прогнать `npx knip --reporter json`
и посчитать элементы `exports` / `types` / `duplicates` по всем файлам.

Плюс один ignore-файл: `scripts/spec-graph.d.mts` (рукописные типы к
`spec-graph.mjs`, кодом не импортируются — нужны LSP). Проверки `files`,
`dependencies`, `unlisted`, `unresolved` — активны.

## 4. Точечные `eslint-disable ... -- baseline` (58 файлов, 89 директив, 91 гашение)

Директив 89, гашений 91: одна директива может перечислять два правила.

| Правило | Штук |
|---|---|
| `@typescript-eslint/prefer-optional-chain` | 22 |
| `@typescript-eslint/no-unnecessary-condition` | 21 |
| `max-lines` (file-level, 400 строк) | 19 |
| `@typescript-eslint/prefer-for-of` | 6 |
| `max-depth` (4) | 6 |
| `@typescript-eslint/no-empty-function` | 5 |
| `@typescript-eslint/no-misused-spread` | 2 |
| `@typescript-eslint/prefer-nullish-coalescing` | 2 |
| `@typescript-eslint/no-unnecessary-type-conversion` | 2 |
| `@typescript-eslint/no-deprecated` | 2 |
| прочие (`no-extraneous-class`, `no-invalid-void-type`, `no-confusing-void-expression`, `no-unnecessary-type-parameters`) | 4 |

Найти все: `grep -rn -- '-- baseline' engine editor tools game desktop scripts`
(один из файлов — `game/demo-ts/app/main.ts`, поэтому `game` в списке нужен).

## 5. Послабления для тестов/скриптов (не баг, осознанная политика)

Блок в `eslint.config.js` для `**/test/**`, `**/*.test.ts`, `**/bin/*.mjs`,
`scripts/**`, демо и фикстур: выключены `max-lines`, `max-depth`,
`sonarjs/cognitive-complexity`, `no-non-null-assertion`, `no-magic-numbers`,
`no-empty-function`, `no-dynamic-delete`. Это не baseline — разгребать не надо.

## 6. Чисто без baseline

- **jscpd** (`lint:dup`): 0.62% дублирования (34 клона на 386 файлах) при пороге
  3% — прошёл сразу. С 2026-08-15 в анализ входит и `game/demo-ts/app/**`:
  исключение осталось от времён, когда демо было примером, и прятало самый
  крупный файл приложения.
- **dependency-cruiser** (`lint:arch`): 0 нарушений на 676 модулях.
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
