# Tasks: sec04-gameplay-spec-alignment

Требования — `specs/ability-system/spec.md` (**ABIL-4**), `specs/netcode/spec.md` (**NET-12**),
`specs/time-system/spec.md` (**TIME-5**), `specs/buff-system/spec.md` (**BUFF-7**),
`specs/input-devices/spec.md` (**INP-5**); разбор решений — design.md (D1–D6). Гейт один и он локальный:
`npm run check` из корня репозитория (CI нет).

Изменение заводилось по факту сделанной работы: валидация спек против кода
(`docs/reviews/spec-validation-2026-09-01/04-gameplay.md`) назвала все пять расхождений; четыре чинятся
текстом требования, пятое (обязанность TIME-5 документировать отношение к TimeScale) — кодом и тестом.

## 1. Дельты требований (D1–D5)

- [x] 1.1 `specs/ability-system/spec.md`: MODIFIED ABIL-4 — абзац о видимости фазы переписан (слот вырезается
      сущностью целиком, противнику виден след фазы в мире), сценарий «Противник видит заряд» приведён к
      этому же. Блок MODIFIED несёт требование ЦЕЛИКОМ со всеми действующими сценариями: MODIFIED заменяет
      блок, и опущенный сценарий архивация молча выкинула бы.
- [x] 1.2 `specs/netcode/spec.md`: MODIFIED NET-12 — та же граница со стороны фильтра: следствие о маске
      слота и сценарий «Кулдауны противника»; названа единица вырезания (сущность, не поле).
- [x] 1.3 `specs/time-system/spec.md`: MODIFIED TIME-5 — запрет на анимацию заменён запретом обратного
      канала; «во сколько раз замедлять клип» оставлено REND-38; новый сценарий «Замедленная сущность в
      кадре».
- [x] 1.4 `specs/buff-system/spec.md`: MODIFIED BUFF-7 — пункт «аура» описывает запрос по области и политику
      `refresh`, сценарий приведён к тому же.
- [x] 1.5 `specs/input-devices/spec.md`: MODIFIED INP-5 — нейтральный ввод у величин-намерений, прицел и
      направление названы последним известным состоянием (TICK-2); новый сценарий.
- [x] 1.6 Перенести дельты в главные спеки (`openspec/specs/**`). Изменение при этом НЕ архивируется: оно
      остаётся в очереди как запись о принятом решении. Проверка — `npx openspec validate --specs --strict`
      и `npm run spec-graph -- check`.

## 2. Код: обязанность TIME-5 (D6)

- [x] 2.1 Каждая нативная система `engine/core-ts/src/systems/**` называет своё отношение к TimeScale строкой
      стенда `TimeScale (TIME-5): учитывает|игнорирует — почему`; у пяти уже документированных систем стенд
      ссылается на их же абзац, у четырнадцати остальных решение записано впервые.
- [x] 2.2 `engine/core-ts/test/timeScaleStance.test.ts`: тест обходит `src/systems/**`, отбирает файлы с
      классом за контрактом `System` и требует стенд у каждого.
- [x] 2.3 `engine/core-ts/src/systems/abilities/visibility.ts`: комментарий маски слота приведён к правленому
      тексту NET-12 — противник видит след каста в мире, а не фазу слота.

## 3. Гейт

- [x] 3.1 Тесты `engine/core-ts`, `engine/integration-ts`, `game/demo-ts`; `npm run typecheck`,
      `npm run lint`, `npm run lint:dead`, `npm run spec-graph -- check`,
      `npx openspec validate --specs --strict` и `--changes --strict`.
