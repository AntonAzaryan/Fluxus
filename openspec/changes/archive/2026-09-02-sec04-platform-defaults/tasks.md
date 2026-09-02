# Tasks: sec04-platform-defaults

Требования — `specs/ability-system/spec.md` (**ABIL-6**), `specs/buff-system/spec.md` (**BUFF-3**),
`specs/npc-behavior/spec.md` (**NPC-5**); разбор решений — design.md (D1–D4). Гейт один и он локальный:
`npm run check` из корня репозитория (CI нет).

Изменение заводилось по факту сделанной работы: валидация спек против кода
(`docs/reviews/spec-validation-2026-09-01/04-gameplay.md`) назвала все три умолчания.

## 1. Дельты требований (D1–D3)

- [x] 1.1 `specs/ability-system/spec.md`: MODIFIED ABIL-6 — исключение у источника `release` названо
      единственным, «замок» по блоку `interrupts` запрещён, отличие от `disable`/`displacement` объяснено
      данными, следствие для авторинга названо нормативно; новый сценарий. Блок MODIFIED несёт требование
      ЦЕЛИКОМ со всеми действующими сценариями.
- [x] 1.2 `specs/buff-system/spec.md`: MODIFIED BUFF-3 — поле `stacking` обязательно, отсутствие — ошибка
      загрузки; новый сценарий.
- [x] 1.3 `specs/npc-behavior/spec.md`: MODIFIED NPC-5 — вытеснение безусловно, обоснование и тай-брейк
      равных минимумов; новый сценарий.
- [x] 1.4 Перенести дельты в главные спеки (`openspec/specs/**`). Изменение НЕ архивируется: остаётся в
      очереди как запись о принятом решении. Проверка — `npx openspec validate --specs --strict` и
      `npm run spec-graph -- check`.

## 2. Ядро

- [x] 2.1 `engine/core-ts/src/systems/abilities/phase.ts`: снят `declares(ability, INTERRUPT_RELEASE)` из
      условия распознавания; комментарий называет единственное исключение и разбирает прежний довод.
- [x] 2.2 `engine/core-ts/src/systems/abilities/buffCatalog.ts`: отсутствие `stacking` — ошибка загрузки,
      называющая бафф и поле.
- [x] 2.3 `engine/core-ts/src/dsl/abilitySchemas.ts`: `buffDef.required` пополнен `stacking`;
      `engine/schemas/*.json` перегенерированы `npm run schemas` (руками схемы не правятся).
- [x] 2.4 `engine/core-ts/src/systems/npc/runtime.ts`: вытеснение наименьшей угрозы безусловно; комментарий
      называет причину и тай-брейк.

## 3. Тесты

- [x] 3.1 `engine/core-ts/test/abilitySystems.test.ts`: «release срывает каст и у определения, которое
      источник не называло (ABIL-6)»; тест цикла фаз держит кнопку — спад бита в фазе, не потребляющей
      удержание, теперь прерывание.
- [x] 3.2 `engine/core-ts/test/buffCatalog.test.ts`: «умолчания у политики нет: молчание документа — ошибка
      загрузки (BUFF-3)»; прежний тест умолчания разделён — имя события реакции проверяется отдельно.
- [x] 3.3 `engine/core-ts/test/npc.test.ts`: «вытеснение безусловно: слабый новичок занимает слот наименьшей
      угрозы».
- [x] 3.4 Фикстуры баффов (`engine/core-ts/test/*`, `engine/integration-ts/test/fixtures.ts`) называют
      политику явно.

## 4. Гейт

- [x] 4.1 Тесты `engine/core-ts`, `engine/integration-ts`, `game/demo-ts`; `npm run typecheck`,
      `npm run lint`, `npm run lint:dead`, `npm run spec-graph -- check`,
      `npx openspec validate --specs --strict` и `--changes --strict`.
