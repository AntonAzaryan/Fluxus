---
name: json-system
description: Author data-driven content for the Fluxus engine — JSON systems (EvaluatedSystem), components, prefabs, scenes and scenarios in the Expression/Action DSL. Use whenever the user asks to write, generate, edit or debug a JSON system, a scene config, gameplay content, DSL expressions/actions, or anything a game designer would tune without touching TS code. Also use when converting gameplay logic between TS and JSON form.
compatibility: Node >= 22.18, workspace installed (npm install из корня репозитория)
---

# Авторинг JSON-систем и контента

Как писать валидный data-driven контент ядра: компоненты, prefab'ы, JSON-системы, сцены и сценарии. Источник истины по формату — сам код (`core-ts/src/dsl/`) и схемы `engine/schemas/*.json` (генерируются из ядра, руками не править).

Полные таблицы операторов и действий с сигнатурами — в [references/dsl.md](references/dsl.md); читай его перед написанием нетривиальной системы. Ниже — конвенции, без которых контент будет невалиден или недетерминирован.

## Числовые конвенции (главный источник ошибок)

- **Все числа в выражениях и полях `fixed` — сырой Q16.16**: `1.0` записывается как `65536`, `10.0` — `655360`, `3.0` — `196608`. Дробные литералы вроде `1.5` в JSON недопустимы — пиши `98304`.
- Поля типа `i32` (индексы, id, маски, `def`/`easing` у твина, `id` модификатора) — сырые целые, **не** Q16.16.
- `tick`, EntityId и ссылки на события — сырые целые; перед арифметикой с Q16.16 приводи `{"fromInt": ...}`, обратно — `{"toInt": ...}`.

## Форма узлов

- Выражение: литерал (`number`/`boolean`) либо объект **ровно с одним ключом-оператором**: `{"+": [a, b]}`. Строка допустима только как имя (компонента, поля, переменной) в позиции аргумента.
- Действие: объект ровно с одним ключом-действием, аргументы **именованные**: `{"modifyComponent": {"entity": ..., "component": "Health", "values": {...}}}`.
- Таблицы операторов и действий закрыты — неизвестное имя валит регистрацию системы (SYS-3), не тик. Это фича: проверяй систему регистрацией/прогоном, а не глазами.
- Циклы существуют только в действиях (`forEach`, `forEachEvent`), в выражениях их нет и не будет (EXPR-5). Случайность — только действия `random`/`randomBelow` (связывают имя в теле `do`), оператора случайности нет: число обращений к RNG должно читаться из текста системы.

## Скелет системы

```json
{
  "name": "Burning",
  "order": 10,
  "query": { "all": ["Burning", "Health"] },
  "as": "e",
  "do": [ ...действия, "e" — id сущности... ]
}
```

`query` + `as` — сахар над действием `forEach` (по умолчанию `as: "entity"`). `order` — целое, задаёт место в расписании; смотри занятые порядки в сцене, куда добавляешь. Живой пример со `spawnEntity`, `emitEvent`, `if` — `engine/tests/golden/burning.scenario.json`.

## Куда что кладётся

- Компоненты/prefab'ы/системы — в `scene` (`SceneDef`, см. `core-ts/src/sim/scene.ts`): `components` (порядок — часть формата!), `prefabs`, `systems`, опционально `terrain`, `arena`, `timeScale`, `tweens`, `fog`, `modifierSlots`.
- Сценарий (`ScenarioDef`, `core-ts/src/sim/scenario.ts`): `name`, `seed`, `ticks`, `scene`, опционально `initial` (порядок задаёт выданные ID), `inputs` + `players`, `physics`, `visibility`.
- Баланс и любые тюнимые числа живут здесь, в JSON — не в коде ядра (mechanism vs policy).
- **Где лежит файл.** Игровой контент — в дереве `content/` (`scenes/`, `matches/`, `visuals/`), никогда внутри пакета движка: `game-content` CONT-1, проверяется тестом `engine/integration-ts/test/contentBoundary.test.ts`. Исключение — фикстуры движка: golden-пары в `engine/tests/golden/` и временные сценарии отладки (CONT-4), они контентом не считаются.

## Проверка написанного

1. Валидируй по схемам: `engine/schemas/system.schema.json`, `scene.schema.json`, `scenario.schema.json` (это generated-файлы — только читать).
2. Прогони сценарием: `npm run sim -- <scenario.json>` из `engine/core-ts/` — регистрация отловит неизвестные операторы/действия/компоненты, прогон покажет поведение потиково.
3. Ошибки вида «неизвестная переменная» — проверь `as`/`let`-биндинги; «ожидалось число, получено object» — где-то вектор попал в скалярную позицию (доставай компоненты `vec.x`/`vec.y`).
4. Если контент должен закрепиться регресс-тестом — сделай из него golden-пару (см. скил `golden-update`).
