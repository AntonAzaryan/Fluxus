# Tasks: minor-remnants-spec-alignment

Требования — дельты в `specs/*/spec.md` (четырнадцать capability, перечень — proposal.md, «Modified Capabilities»); разбор решений — design.md (D1–D9). Гейт локальный: `npm run check` из корня (CI нет).

Изменение заводится по факту сделанной работы: пятьдесят находок ⚪ валидации спек 2026-09-01 закрываются одним заходом, после чего отчёты валидации снимаются.

## 1. Норма по работающему движку (D1)

- [x] 1.1 ~~`specs/rng/spec.md`: MODIFIED RNG-8~~ — закрыт параллельно в main (`sec01-rng-bound-range`), при слиянии взята редакция main; дельта снята.
- [x] 1.2 `specs/tick-loop/spec.md`: MODIFIED TICK-2 — необязательность `target`, сценарий «Кадр без точки прицела».
- [x] 1.3 `specs/data-driven-systems/spec.md`: MODIFIED SYS-5 — норма о контракте, сценарий про расширение типа.
- [x] 1.4 `specs/npc-behavior/spec.md`: MODIFIED NPC-4 — поле `decisionBudget`, умолчание «без предела», ноль — находка валидации; сценарий.
- [x] 1.5 `specs/diagnostics/spec.md`: MODIFIED DIAG-4 — сигнал о сломанном sink'е — исключение без кода в словаре (D8).
- [x] 1.6 `specs/locomotion/spec.md`: MODIFIED LOC-5 и LOC-6 — нормированное направление прыжка, безусловный override (D3); сценарии.
- [x] 1.7 `specs/physics/spec.md`: MODIFIED PHYS-11 — сторона захода по знаку шага, скольжение вдоль обрыва; сценарий.
- [x] 1.8 `specs/serialization/spec.md`: MODIFIED SER-6 — правило действует на формы ядра, документ автора — авторский (D7); сценарий уточнён и добавлен.

## 2. Противоречия между спеками

- [x] 2.1 `specs/net-session/spec.md`: MODIFIED SES-1 — строка `local` снята, сценарий «Матч на одного» (D4).
- [x] 2.2 `specs/fog-of-war/spec.md`: MODIFIED FOW-4 (handle-двойники SYS-10) и FOW-7 (маска после любого прохода REND-34); `## Notes` — таблица `## Purpose`: SNAP-5 → SNAP-1.
- [x] 2.3 `specs/snapshot-rewind/spec.md`: MODIFIED SNAP-1 — число живых сущностей; сценарий.
- [x] 2.4 `specs/assets/spec.md`: MODIFIED ASSET-16 — ссылка вместо повторённого перечня; `## Notes` — абзац о брони ASSET-15 в `## Purpose`.

## 3. Шум вместо молчания и унификация (D2, D6)

- [x] 3.1 `specs/physics/spec.md`: MODIFIED PHYS-6 — начало луча внутри чужого коллайдера; сценарий «Луч из середины чужого укрытия».
- [x] 3.2 `specs/ability-system/spec.md`: MODIFIED ABIL-5 (поля точки прицела) и ABIL-6 (исход `cancelInput` без бита); сценарии.
- [x] 3.3 `specs/time-system/spec.md`: MODIFIED TIME-8 — модификатор на сущность без списка; сценарий.

## 4. Код

- [x] 4.1 `engine/core-ts`: RNG-8, DET-9 и DET-2 — редакция main (`sec01-rng-bound-range`, слияние), REW-2 (D5), SER-6 (общее дополнение нулями), NPC-6 (индекс маршрутов), ABIL-2, ABIL-5, ABIL-6, TIME-8, DIAG-4, ACT-5, CMD-5, комментарии (DI-3/DI-6, DI-3/DI-4, FP-5, OBS-3, TWEEN-1, SNAP-2/SNAP-4, CLI-7).
- [x] 4.2 `engine/core-ts`: PHYS-6 (круг — попадание на нуле), ARENA-3 (флаг по правилу ECS-3, запись только на смене стороны).
- [x] 4.3 `engine/net-ts`: SES-1 (тип), NTR-4 (перечни и `protocol-error`), шапка `BranchHistory`, DI-6 в тесте границы.
- [x] 4.4 `engine/client-ts`, `engine/hud-ts`, `game/demo-ts`: SHELL-4 (счётчик до HUD), SHELL-4/HUD-5 (накопитель), SHELL-3 (возврат буфера), QUAL-3 (константная стоимость HUD), комментарий про пресет «баланс».
- [x] 4.5 `desktop/shell-ts`, `game/server-manager-ts`, `game/server-agent-ts`: DSK-8, MGR-4, SRV-4.
- [x] 4.6 `tools/blender-addon/grids.py` (BLND-10), `engine/core-ts/bin/sim.mjs` (CLI-7).

## 5. Документы и очередь

- [x] 5.1 `docs/one-pager.md` — название; `docs/architecture.md` и заготовки `sec09-*` — ссылки на отчёты заменены словами.
- [x] 5.2 Заготовка `blender-import-from-editor` (вторая половина BLND-5, D9).
- [x] 5.3 `docs/reviews/spec-validation-2026-09-01/` удалён.

## 6. Синхронизация и гейт

- [x] 6.1 Перенести дельты в `openspec/specs/*/spec.md` побайтово по требованию и заархивировать изменение (`openspec archive minor-remnants-spec-alignment --yes --skip-specs`).
- [x] 6.2 Из корня: `npx openspec validate --specs --strict`, `npx openspec validate --changes --strict`, `npm run spec-graph -- check`.
- [x] 6.3 Из корня: `npm run check`.
