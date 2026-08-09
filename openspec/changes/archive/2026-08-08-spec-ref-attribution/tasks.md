# spec-ref-attribution — tasks

## 1. Правка атрибуций

- [x] 1.1 Дельта `specs/arena/spec.md`: ARENA-5, «(`ecs-foundation` DI-3 …)» → «(`determinism-core` DI-3 …)», остальной текст секции без изменений
- [x] 1.2 Дельта `specs/locomotion/spec.md`: LOC-1, «(`ecs-foundation` SYS-4)» → «(`data-driven-systems` SYS-4)», остальной текст секции без изменений

## 2. Проверка

- [x] 2.1 `openspec validate spec-ref-attribution` и `openspec validate --specs --strict` — зелено
- [x] 2.2 После архива: `spec-graph check` — ноль находок; дифф main-спек — ровно два требования, в каждом одно слово
