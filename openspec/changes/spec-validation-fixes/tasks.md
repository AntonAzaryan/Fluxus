# Tasks — spec-validation-fixes

Номера находок — по `docs/reviews/2026-08-09-spec-validation.md`. Разбиение — по файловой принадлежности (параллельные исполнители не пересекаются по файлам).

## 1. Харнесс и доки (A)

- [x] 1.1 Р2: `scripts/spec-graph.layers.json` — исключения `assets → editor` (ASSET-9→ED-19) и `terrain → editor` (TERR-3→ED-10) с обоснованиями; `$comment` перестаёт обещать гейт по направлению слоёв
- [x] 1.2 Р3: `docs/architecture.md` §2 — строка `presentation-scene`, актуальные диапазоны ED/CAM/ASSET/REND
- [x] 1.3 Р5: CLAUDE.md — пункт о Command Buffer учитывает исключение TICK-3 (`worldInit`-хелпер); сверка с config.yaml

## 2. Швы сетевых pending-изменений (B)

- [x] 2.1 П3: `rewind-epoch` + `net-event-delivery` — эпоха у сообщения `Events` (или явный deferral с владельцем)
- [x] 2.2 П2: `filter-ownership` + `net-event-delivery` — закрытие утечки шины в персональном снапшоте явно, не молчанием

## 3. Сеть, main-спеки (C)

- [x] 3.1 П5: SES-4 ↔ NTR-4/5/6 — состав `Welcome`
- [x] 3.2 П6: NET-10 ↔ SNAP-2/SNAP-4 — модель клиентской истории
- [x] 3.3 П7: NET-8 — оговорка про JSON-дебаг NTR-13
- [x] 3.4 П8: SES-1 `local` ↔ SES-2/NTR-13
- [x] 3.5 С1: перевес «ядро о сети не знает» с DI-3 на DI-6 (NET-17, NTR-1, NTR-16, преамбула netcode-transport)
- [x] 3.6 С2/С3: CLI-8 → CORE-5 (zero-deps) и корректная атрибуция «чистого цикла» (NTR-3, не NTR-10)
- [x] 3.7 С4: перечтение REW-4 в NET-11/NTR-7/NTR-16
- [x] 3.8 С5: REW-5-миссайты в NTR-7/NET-11
- [x] 3.9 С6: Open Question netcode → NTR-9
- [x] 3.10 С7: NET-12 → ID-3+ID-6
- [x] 3.11 Т5: кадр/фрейм в netcode-transport
- [x] 3.12 Т6: CLI-3 — состав записи тика против правила чтения SNAP-1
- [x] 3.13 Т14: DIAG-5 — исход «перекрыта» против фактической семантики CMD-3/CMD-7
- [x] 3.14 Т17: классификация Purpose snapshot-rewind (REW-2, REW-6)

## 4. Мир и локомоция, main-спеки (D)

- [x] 4.1 П9: PHYS-2 ↔ TERR-4 — вторая конвенция имени
- [x] 4.2 П10: TERR-5/PHYS-10/FOW-5 — масочная модель вместо тега блокировки (+ ребейз дельты FOW-5 в `spec-terminology`)
- [x] 4.3 П11: NAV-1 — исключение для старт==цель (NAV-5)
- [x] 4.4 П12: FOW-5 — `levelOf`/override (TERR-4), снимает и CLIFF_TAGS-миссайт
- [x] 4.5 П13 (locomotion): пятое состояние `Window` в LOC-3/LOC-4
- [x] 4.6 С17: INP-4 → LOC-1
- [x] 4.7 Т7: TERR-2 ↔ TERR-3 — закрытый алфавит против «набора флагов»

## 5. Редактор и камера, main-спеки (E)

- [x] 5.1 П14: ED-13 ↔ CAM-8/CAM-4
- [x] 5.2 П15: ED-15 ↔ CAM-8 — кадрирование в облёте
- [x] 5.3 П16: ED-6 — схема `Tween` вместо «таблицы твинов»
- [x] 5.4 С11/С12: ED-6 → SER-7; ED-6 ↔ DET-1 (битовые id)
- [x] 5.5 С13: CAM-7 → TERR-6 («карта уровней», не «арена»)
- [x] 5.6 С14: CAM-5 — владелец порога snap
- [x] 5.7 С15: PRES-4 → CLI-3/CLI-5
- [x] 5.8 С16: ED-14 → ASSET-8/CAM-6
- [x] 5.9 Т2/Т3/Т4: облёт=Fly, «клиф», знак/иконка
- [x] 5.10 Т11: ED-26 — общее правило недоступности по-настоящему общее
- [x] 5.11 Т12/Т13: сценарий PRES-1 ↔ CONT-5; обоснование дописывания полей ED-6

## 6. Rendering/assets/serialization, main-спеки (F)

- [x] 6.1 П17: REND-1 — закрытый список входов и Purpose догоняют мердж
- [x] 6.2 П18: ASSET-6 — `scale` в составе записи манифеста
- [x] 6.3 П13 (rendering): REND-4 — окно даблтапа как состояние `Window`
- [x] 6.4 С20: SER-7/SER-5 — поле `physics` наравне с `visibility`
- [x] 6.5 Т1: хендшейк → handshake

## 7. Ядро, main-спеки (G)

- [x] 7.1 Т19: TICK-2 ↔ TICK-4 — взаимодополняющие слои, явное примирение
- [x] 7.2 Т20: TICK-4 «минимальный order» → якорь DET-9 (+ ребейз дельт `native-system-order`)
- [x] 7.3 С1/С2-владельцы: новые CORE-5 (zero runtime deps) и DI-6 (ядро о сети не знает)
- [x] 7.4 С9: TIME-8 → REW-2
- [x] 7.5 С10: TICK-2 сценарий → граница NTR-7
- [x] 7.6 С18: TIME-7 — обоснование клампа
- [x] 7.7 С19: DET-9 — владелец `TimeScaleSystem`
- [x] 7.8 Т8/Т9/Т10: RNG-6 `let`, TWEEN-6 «напрямую», Open Question rng
- [x] 7.9 Т15: TICK-4 — `seq` в составе компонента ввода (INPUT_FIELDS)

## 8. Код редактора (H)

- [x] 8.1 Р1: парный presentation-документ возникает при первой decoration-правке (расстановка, prop→decoration); тесты, закреплявшие «писать некуда», переписаны
- [x] 8.2 Р4: аддендум `docs/reviews/2026-08-08-editor-coverage.md` отражает новое поведение

## 9. Финализация (оркестратор)

- [x] 9.1 `openspec validate --specs --strict`, `spec-graph check`, полный `npm run check`
- [x] 9.2 Сквозная вычитка диффа на согласованность правок между кластерами
- [x] 9.3 Отметка статусов в отчёте, коммиты, пуш, мердж в main
