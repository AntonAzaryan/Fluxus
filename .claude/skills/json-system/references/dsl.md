# Справочник DSL: операторы и действия

Источник истины — `core-ts/src/dsl/expr.ts` (таблица `OPS`) и `core-ts/src/dsl/actions.ts` (таблица `ACTIONS`). Если этот файл разошёлся с кодом — прав код; экспорты `operators` и `actionNames` дают актуальные списки имён.

## Операторы выражений (expr.ts)

Аргументы — массив: `{"op": [a, b]}`; единственный аргумент можно без массива: `{"abs": x}`. Результат — число (Q16.16 или сырое целое), булево или вектор `{x, y}`.

### Окружение

| Оператор | Сигнатура | Примечание |
|---|---|---|
| `var` | `["имя"]` | биндинг из `as`/`let`/`random`; неизвестное имя — ошибка |
| `tick` | `[]` | номер тика, **сырое целое** — для арифметики нужен `fromInt` |
| `getComponent` | `[entity, "Comp", "field"]` | масштаб поля тот, что в схеме (`fixed`/`i32`) |
| `hasComponent` | `[entity, "Comp"]` | → bool |
| `isAlive` | `[entity]` | → bool |
| `eventField` | `[eventRef, "field"]` | `eventRef` — имя из `forEachEvent`; отсутствующее поле — ошибка, не 0 |

### Арифметика Q16.16

`+`, `-`, `*`, `/` (по два аргумента), `min`, `max`, `abs`, `sqrt`, `clamp [x, lo, hi]`.

Приведение масштаба: `fromInt` (целое → Q16.16), `toInt` (Q16.16 → целое, усечение).

`bitTest [mask, bit]` — проверка бита `i32`-маски (bit 0..31) → bool; единственная битовая операция (фронт кнопки ввода).

### Сравнения и логика

`<`, `<=`, `>`, `>=`, `==`, `!=` (векторы целиком сравнивать нельзя — только покомпонентно); `and`, `or` (≥2 аргументов, вычисляются все — короткого замыкания с эффектами тут нет, выражения чистые), `!`; `if` — `[cond, then, cond2, then2, …, else]` (нечётное число аргументов).

### Векторы

`vec [x, y]` — конструктор; `vec.add`, `vec.sub`, `vec.dot`, `vec.length`, `vec.lengthSq`, `vec.normalize`, `vec.scale [v, k]`, `vec.x`, `vec.y`. Вектор — значение `{x, y}` в Q16.16; в поля компонентов кладётся покомпонентно.

## Действия (actions.ts)

Аргументы всегда именованные. Имена компонентов/полей/переменных — строковые литералы (не выражения). Ключи в `values`/`data`/`overrides`/`bindings` исполняются в **отсортированном** порядке имён (ACT-3) — не полагайся на порядок записи.

### Мутации ECS (все — через Command Buffer, видимы после flush системы)

| Действие | Аргументы |
|---|---|
| `modifyComponent` | `entity`, `component`, `values: {поле: expr}` |
| `addComponent` | `entity`, `component`, `values` |
| `removeComponent` | `entity`, `component` |
| `spawnEntity` | `prefab`, `overrides?: {Comp: {поле: expr}}` |
| `destroyEntity` | `entity` |
| `emitEvent` | `type`, `data?: {поле: expr}` — масштаб полей определяет эмитент |

### Специализированные

| Действие | Аргументы | Примечание |
|---|---|---|
| `addTween` | `entity`, `def`, `from`, `to`, `duration`, `easing?`, `ignoreTimeScale?` | `def`/`easing`/`ignoreTimeScale` — сырые `i32`; `def` — индекс в `scene.tweens` |
| `addModifier` | `component`, `entity`, `id`, `value` | `id` — сырое целое, `value` — множитель Q16.16 |
| `removeModifier` | `component`, `entity`, `id` | отсутствующий id — не ошибка |

### Управление потоком

| Действие | Аргументы | Примечание |
|---|---|---|
| `if` | `cond`, `then: [...]`, `else?: [...]` | cond обязан быть булевым |
| `let` | `bindings: {имя: expr}`, `do: [...]` | биндинги вычисляются параллельно во внешней области, не по цепочке |
| `forEach` | `query`, `as`, `do` | query: `all`/`any`/`not` (списки компонентов), `withTag`, `withinRadius: {center, radius}` (center/radius — выражения); результат материализован до итерации |
| `forEachEvent` | `type`, `as`, `do` | `as` связывает ссылку на событие для `eventField`; длина шины берётся до обхода |
| `random` | `as`, `do`, `subStream?` | Q16.16 из стрима системы (или суб-стрима) |
| `randomBelow` | `bound`, `as`, `do`, `subStream?` | равномерное целое `[0, bound)`, bound ≥ 1 (в Q16.16, приводится `toInt` внутри) |
