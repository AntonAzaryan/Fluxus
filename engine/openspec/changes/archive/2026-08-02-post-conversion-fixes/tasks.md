## 1. FOW-9 и Purpose спеки fog-of-war

- [x] 1.1 Заменить FOW-9 в `openspec/specs/fog-of-war/spec.md` на версию из delta-спеки (SHOULD, «чуть меньше», MAY / NOT REQUIRED); сценарий оставить прежний
- [x] 1.2 Добавить в Purpose спеки `fog-of-war` абзац про отключаемость capability и обязательность для этой игры (wallhack/ESP)

## 2. Открытые вопросы по спекам

Формат: строка-заголовок + 1–2 предложения контекста + пометка слоя. Без SHALL/MUST. Секция `## Open Questions` — в конец файла.

- [x] 2.1 `snapshot-rewind`: пейс глобальной перемотки; FoW × глобальный rewind (viewpoint во время перемотки)
- [x] 2.2 `netcode`: модель отзывчивости; стоимость per-client фильтрации; кто получает `viewpoint = ALL`; политика видимости событий и снарядов
- [x] 2.3 `fog-of-war`: гранулярность видимости; LoS-обрезка в рендере; ссылки на вопросы из `snapshot-rewind` и `netcode`, касающиеся FoW
- [x] 2.4 `tick-loop`: гранулярность dirty-tracking
- [x] 2.5 `rng`: именованные суб-стримы
- [x] 2.6 `time-system`: может ли TimeScale замедлять cooldown rewind-ульты из exempt-списка REW-9

## 3. EVT-4

- [x] 3.1 Добавить примечание о происхождении рядом с требованием в `openspec/specs/data-driven-systems/spec.md`; нормативный текст не менять

## 4. project.md и бэклог changes

- [x] 4.1 Проверить наличие §1 (диаграмма + принципы), §18 (LLM-friendly workflow), §19 (roadmap) в `openspec/project.md` или аналоге; добавить недостающее

  Результат: `openspec/project.md` в схеме `spec-driven` не предусмотрен, его роль делят `openspec/config.yaml` (`context` — стек и неснимаемые принципы §1) и `docs/architecture.md` (§1 диаграмма слоёв, §4 LLM-friendly workflow = §18 оригинала, §5 roadmap = §19 оригинала со строкой «каждый этап заводится как change»). Всё на месте, изменений не требуется.

## 5. Проверка

- [x] 5.1 `openspec validate --specs --strict`
- [x] 5.2 `openspec validate --change post-conversion-fixes --strict`
- [x] 5.3 Убедиться, что у каждого затронутого требования остался минимум один Scenario и ID-префикс в заголовке
