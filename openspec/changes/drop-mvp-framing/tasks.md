## 1. Требования с изменённым условием

- [ ] 1.1 Применить дельту `determinism-core` к `openspec/specs/determinism-core/spec.md`: переименовать заголовки CORE-1 и CORE-4, заменить их нормы и сценарии текстом дельты; проверить `grep -n "MVP" openspec/specs/determinism-core/spec.md` → пусто и `openspec spec show determinism-core` показывает CORE-1..CORE-5 без пропусков
- [ ] 1.2 Применить дельту `netcode-transport` в части NTR-10: переименовать заголовок, снять ярлык в норме и обоих сценариях; проверить, что формулировка сошлась с комментарием в `engine/client-ts/src/networkShell.ts` («предсказания у клиента пока нет (NTR-10)»)

## 2. Требования, теряющие ярлык без изменения нормы

- [ ] 2.1 Применить дельты `netcode` (NET-8, NET-18) и `snapshot-rewind` (SNAP-4); проверить `grep -c "MVP"` по обоим файлам → 0
- [ ] 2.2 Применить дельты `fog-of-war` (FOW-2, FOW-7, FOW-9) и `rendering` (REND-7, REND-8); проверить `grep -c "MVP"` по обоим файлам → 0
- [ ] 2.3 Применить дельты `netcode-transport` (NTR-6, NTR-9, NTR-12, NTR-14, NTR-17), `net-session` (SES-5), `client-shell` (SHELL-6) и `data-driven-systems` (EXPR-1); проверить `grep -c "MVP"` по всем четырём файлам → 0

## 3. Ненормативная проза

- [ ] 3.1 Снять ярлык в `## Purpose` спеки `rendering` («добавляются после MVP» → «добавляются позже») и в её открытом вопросе «Направление корпуса при стрейфе» («MVP доворачивает корпус» → «Корпус доворачивается»)
- [ ] 3.2 Снять ярлык в открытых вопросах `fog-of-war` («Гранулярность видимости»), `assets` («Время жизни и выгрузка», «Паковка и рантайм-BLP») и `netcode` («Кто получает `viewpoint = ALL`»)
- [ ] 3.3 Снять ярлык в открытых вопросах `netcode-transport` («Склейка хешей многосценового контент-пака», «Продакшн-авторизация полного потока»); формулировка про контент-пак должна сойтись с сообщением в `engine/net-ts/src/content/pack.ts` («контент-пак содержит ровно одну сцену»)
- [ ] 3.4 Обновить `openspec/config.yaml`: «Стек: TypeScript (ядро MVP)» → «Стек: TypeScript (ядро)», «Никакого WASM в MVP» → формулировка нового CORE-4; проверить `grep -c "MVP" openspec/config.yaml` → 0

## 4. Дельты незаархивированного change'а

- [ ] 4.1 Снять ярлык в `openspec/changes/render-lifetime-and-spec-alignment/specs/fog-of-war/spec.md` (FOW-7) и `specs/rendering/spec.md` (REND-8, плюс цитата в `## Notes`) — теми же подстановками, что в дельтах этого change'а; проверить, что после архивации того change'а ярлык в основные спеки не вернётся

## 5. Сверка

- [ ] 5.1 `grep -rn "MVP" openspec/specs/ openspec/config.yaml` → пусто; `grep -rn "MVP" openspec/changes/ --exclude-dir=archive` → только дельты и артефакты этого change'а
- [ ] 5.2 `openspec validate --specs --strict` и `npm run spec-graph -- check` зелёные; ни один ID не потерян — сверить список `CORE-1 CORE-4 DI-4 NTR-6 NTR-9 NTR-10 NTR-12 NTR-14 NTR-17 NET-8 NET-18 FOW-2 FOW-7 FOW-9 REND-7 REND-8 SNAP-4 EXPR-1 SES-5 SHELL-6` через `npm run spec-graph -- show <ID>`
- [ ] 5.3 `npm run check` из корня зелёный (правок кода change не несёт — красным гейт стать не может; прогон подтверждает, что `spec-graph check` не сломан переименованием заголовков)
- [ ] 5.4 Сверить блок «Неснимаемые принципы» в `openspec/config.yaml` с одноимённым разделом `CLAUDE.md` — формулировка про WASM должна совпадать в обоих
