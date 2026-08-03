## 1. Применение дельт в основные спеки

- [x] 1.1 В `openspec/specs/arena/spec.md` заменить ARENA-3 на версию из дельты: событие `LeftArena` только для сущностей с `ArenaState`, компонент `ArenaState { inside, onFloor }` описан впервые с обоснованием по аналогии с TICK-4
- [x] 1.2 В `openspec/specs/arena/spec.md` заменить ARENA-5 на версию из дельты: событие `FellThroughFloor` через то же поле `onFloor` компонента `ArenaState`, ссылка на ARENA-3
- [x] 1.3 В `openspec/specs/fog-of-war/spec.md` заменить FOW-1 на версию из дельты: ссылка на предел эффективного радиуса обзора из `physics` PHYS-6
- [x] 1.4 В `openspec/specs/fog-of-war/spec.md` заменить FOW-5 на версию из дельты: безусловное взведение бита своей команды до `withinRadius`/`raycast`/фильтра уровня; сценарий «наблюдатель сверху» переписан с учётом блокировки LoS обрывом (TERR-5, CLIFF_TAGS)

## 2. Прямая правка Open Questions (не дельта)

- [x] 2.1 В `openspec/specs/fog-of-war/spec.md`, раздел `## Open Questions`, добавить пункт: направленный обзор с высоты (наблюдатель выше цели видит через обрыв в направлении вниз) — рассмотреть отдельным будущим change; сам раздел требований (FOW-1..9) не трогать

## 3. Проверка когерентности

- [x] 3.1 `openspec validate spec-catchup-arena-fow --strict` проходит
- [x] 3.2 Убедиться, что MODIFIED-блоки ARENA-3, ARENA-5, FOW-1, FOW-5 содержат полный текст требования со всеми сценариями, а не патч
- [x] 3.3 Убедиться, что код (`src/systems/arena.ts`, `src/systems/visibility.ts`) не менялся — это чистая нормировка текста спек под уже реализованное поведение
