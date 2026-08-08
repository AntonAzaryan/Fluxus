## 0. Порядок в очереди

- [ ] 0.1 Гейт синхронизации, а не реализации: на сегодня `editor-viewport-ergonomics` в главную спеку НЕ синхронизирован (последний номер `camera` — `CAM-7`), поэтому галочка снята до архивации. Убедиться, что `editor-viewport-ergonomics` синхронизирован в главную спеку раньше этого change: он занимает `CAM-8`, здесь взят `CAM-9` (`proposal.md`, «Порядок в очереди»). Если порядок перевернулся — переименовать требование обратно в `CAM-8` во всех файлах этого change'а и перевести `editor-viewport-ergonomics` на `CAM-9`; дырой в нумерации `camera` оставлять нельзя
- [x] 0.2 Убедиться, что `dedup-normative-duplicates` ещё НЕ синхронизирован: дельта `ASSET-8` здесь построена на действующем тексте главной спеки. Если он ушёл раньше — заменить второй абзац дельты на его редакцию (текст приведён в `proposal.md` дословно) перед синхронизацией
- [ ] 0.3 После синхронизации этого change'а перестроить дельту `ASSET-8` в `dedup-normative-duplicates` по слитому тексту — тем же приёмом, каким `terminology-sweep` перестроен по слитому `REND-1`
- [ ] 0.4 Координация по файлам с соседями по очереди: `editor/ui-ts/src/areas/sceneProject.ts` и `editor/ui-ts/app/assembly.ts` правит и `editor-authoring-areas` (его WP8) — регистрация правил движка (задача 5.3) и регистрация двух новых областей сходятся в этих двух файлах

## 1. Форма описания в модуле ассетов

- [x] 1.1 В `engine/assets-ts/src/manifest.ts` объявить контракт описания рядом с `CameraEffectDef`: `CameraEffectKind = 'impulse' | 'lasting'`, `CameraEffectParamSpec { name, defaultValue, min?, max? }`, `CameraEffectTypeSpec { id, kind, params }`, `CameraEffectsDescription { types, binding: Record<CameraEffectKind, readonly CameraEffectParamSpec[]> }`; фабрики эффекта в контракте нет — она render-специфична (design.md, «Описание живёт в камере, а его форма — в модуле ассетов»)
- [x] 1.2 Экспортировать новые типы из `engine/assets-ts/src/index.ts`

## 2. Описание типов эффектов в камере (CAM-9)

- [x] 2.1 В `engine/render-ts/src/camera/effects.ts` объявить дескрипторы рядом с их классами: `SHAKE_TYPE` (`impulse`; `frequency`, `maxOffset`, `maxRoll`, `decay`) и `SWAY_TYPE` (`lasting`; `rollAmp`, `yawAmp`, `fovAmp`, `frequency`, `fadeSeconds`) — умолчания и границы осмысленности в дескрипторе, а не в отдельной константе
- [x] 2.2 Вывести `DEFAULT_SHAKE`/`DEFAULT_SWAY` из дескрипторов (`defaults(spec)`), чтобы умолчание не жило в двух местах; сигнатуры конструкторов `TraumaShake`/`SwayEffect` не менять
- [x] 2.3 Привести классы к контрактам вида: `ImpulseEffect { trigger(strength) }` (переименование `TraumaShake.addTrauma`), `LastingEffect { setActive(active) }` (у `SwayEffect` уже есть); поправить вызовы в `engine/render-ts/test/cameraEffects.test.ts`
- [x] 2.4 Новый `engine/render-ts/src/camera/effectTypes.ts`: `CAMERA_EFFECTS_DESCRIPTION` — замороженное описание (`types` из дескрипторов + `binding.impulse` = `amplitude`, `radius`), поиск типа по id; ни одной человекочитаемой строки в файле (CAM-9)
- [x] 2.5 Экспортировать описание и типы дескрипторов из `engine/render-ts/src/index.ts`

## 3. Диспетчер строит эффекты по описанию (CAM-6)

- [x] 3.1 В `engine/render-ts/src/camera/director.ts` заменить обе ветки `def.effect !== '…'` и оба набора `num(def, …)` на общий путь: поиск дескриптора по `def.effect` → сверка `kind` с таблицей записи → сбор параметров по `spec.params` (значение записи, иначе умолчание, с приведением к диапазону) → `create`
- [x] 3.2 Параметры привязки (`amplitude`, `radius`) читать по `description.binding[kind]`, а не по литералам ключей
- [x] 3.3 Сохранить одноразовость предупреждений на запись и добавить случай «тип объявлен эффектом другого вида, чем таблица» (CAM-6, сценарий «Импульсный тип в таблице состояний»)
- [x] 3.4 Описание — параметр директора (`CameraEffectsDirectorOptions.description`) с умолчанием `CAMERA_EFFECTS_DESCRIPTION`: тест подаёт своё, потребитель не подаёт ничего
- [x] 3.5 Тесты в `engine/render-ts/test/cameraEffects.test.ts`: выдуманный тип из подставленного описания работает end-to-end без правки директора; параметр вне диапазона приводится к границе; несовпадение вида даёт предупреждение и пропуск
- [x] 3.6 Сканер исходника (по образцу `editor/ui-ts/test/frameDomain.test.ts`): в `director.ts` нет ни одного идентификатора типа эффекта — свойство «перечень типов один» обычным прогоном не ловится

## 4. Валидация секции по описанию (ASSET-8)

- [x] 4.1 В `engine/assets-ts/src/manifest.ts` расширить `validateManifest(doc, options?: { cameraEffects?: CameraEffectsDescription })` и добавить `warnings: readonly string[]` в обе ветки результата; без описания поведение прежнее
- [x] 4.2 В `validateCameraEffects` добавить проверки по описанию: неизвестный тип, тип другого вида, чем таблица, и незаявленный параметр — в предупреждения; значение вне `min`/`max` — в ошибки, сообщением того же формата «путь: текст»
- [x] 4.3 Тесты в `engine/assets-ts/test/manifest.test.ts`: с описанием и без; предупреждение не делает манифест невалидным; ошибка диапазона адресует поле
- [x] 4.4 `engine/assets-ts/src/loaders/manifest.ts` — принимать описание из контекста загрузчика (или опций сервиса) и логировать предупреждения один раз, не роняя загрузку (ASSET-4, ASSET-8)
- [x] 4.5 Передать `CAMERA_EFFECTS_DESCRIPTION` там, где клиент поднимает манифест и директора (`engine/client-ts/demo/main.ts` и сборка клиента)

## 5. Правило редактора получает описание (ED-8, ED-14)

- [x] 5.1 В `editor/core-ts/src/validation/adapters.ts` расширить `ErrorListResult` необязательным `warnings` и научить `reportErrorList` заводить находки важности `warning` с тем же разбором адреса; `validateCurvatureMap` не трогать
- [x] 5.2 В `editor/core-ts/src/validation/engineRules.ts` — опция правил движка с описанием эффектов (по образцу `EngineRuleKinds`: знание приносит сборка, не правило) и передача её в `validateManifest` внутри `manifestRule`
- [x] 5.3 В `editor/ui-ts/src/areas/sceneProject.ts` включить в `sceneValidationRules()` правила движка с видами документов этого проекта (`visuals`, `scene`, `terrain-curvature`) и с `CAMERA_EFFECTS_DESCRIPTION` — сегодня `engineValidationRules()` в собранном редакторе не регистрируется вовсе, и правило `assets.manifest` там не работает (design.md)
- [x] 5.4 Тесты: `editor/core-ts/test/validationRules.test.ts` — находки секции с адресом и важностью; `editor/ui-ts/test/validation.test.ts` (или `sceneArea.test.ts`) — правила движка присутствуют в реестре сборки

## 6. Междокументное правило имени состояния (ED-8)

- [x] 6.1 В `editor/core-ts/src/validation/crossDocument.ts` добавить `editor.cameraEffectState`: ключ таблицы `states` манифеста, не совпадающий ни с одной компонентой открытой сцены, — находка важности `warning`; при отсутствии открытых сцен правило молчит (общее правило файла)
- [x] 6.2 Строки описания правила и причины — в бандл `@game-mvp/editor-core` (`editor.ru.json`, `editor.en.json`), отпечатки перевода пересобрать `UPDATE_FINGERPRINTS=1 npx vitest run` из `editor/core-ts`
- [x] 6.3 Тест в `editor/core-ts/test/validationRules.test.ts` — по образцу «ED-19: рассинхронизация пары»

## 7. Операции секции (ED-29)

- [x] 7.1 Новый `editor/ui-ts/src/areas/assetCameraEffects.ts` с шапкой в духе `assetVisuals.ts`: пути секции (`cameraEffects.events|states`) — доменное знание вклада; операция `visuals.cameraEffects.bind` (`document`, `table`, `name`, `effect`) — заводит или перетипизовывает запись, пишет только `effect`, при смене типа удаляет параметры, которых новый тип не объявляет
- [x] 7.2 Операция `visuals.cameraEffects.setParam` (`document`, `table`, `name`, `param`, `value`) — имя параметра сверяется с описанием, значение с диапазоном; отдельной операции удаления не заводить (`document.removeValue`, как решено в `assetVisuals.ts`)
- [x] 7.3 Правленую запись отдавать на проверку владельцу формата и о разнице (`checkEntry` из `assetVisuals.ts` — вынести общий помощник либо повторить его контракт)
- [x] 7.4 `registerCameraEffectsOperations(registry)` и регистрация в `editor/ui-ts/app/assembly.ts` рядом с `registerVisualsOperations`
- [x] 7.5 Строки параметров операций (`ui.operation.param.*`) и их описаний — в `editor/ui-ts/src/i18n/locales/ui.{ru,en}.json`
- [x] 7.6 Тесты в `editor/ui-ts/test/assetArea.test.ts` (или новом `cameraEffects.test.ts`): обратимость каждой операции (ED-29), отказ на незаявленный параметр и на значение вне диапазона, исполнение без интерфейса, отсутствие второго пути правки секции

## 8. Таблицы в области ассетов (ED-14, ED-24)

- [x] 8.1 В `editor/ui-ts/src/areas/assets.ts` (зона инспектора) добавить две группы — импульсные и длящиеся привязки: строка = запись таблицы, выбор строки делает её субъектом полей
- [x] 8.2 Перечень типов для выбора — `description.types`, отфильтрованный по виду таблицы; поля записи — `spec.params` выбранного типа плюс `description.binding[kind]`; списка типов в редакторе не заводить ни в каком виде (ED-14)
- [x] 8.3 Подсказки полей — по ключу ED-28 из пути `['cameraEffect', <type>, <param>]` (`descriptionKey` из `@game-mvp/editor-core`)
- [x] 8.4 Подсказка имён событий: собрать литералы `emitEvent.type` из открытых документов сцен как список выбора; находок на неизвестное имя не заводить (design.md, «Имена событий подсказываются, а не проверяются»)
- [x] 8.5 Тест в `editor/ui-ts/test/assetArea.test.ts`: тип, добавленный в подставленное описание, появляется в таблице со своими полями — список в редакторе не правится (ED-14, сценарий «Новый тип эффекта в коде камеры»)

## 9. Строки описаний типов (ED-27, ED-28)

- [x] 9.1 Новый бандл `editor/ui-ts/src/i18n/cameraEffectBundles.ts` с префиксом `cameraEffect.` и локалями `locales/cameraEffect.{ru,en}.json`; влить в `uiResources` рядом с `UI_BUNDLES`
- [x] 9.2 Заполнить описания для `shake` и `sway` и всех их параметров плюс параметров привязки, обе локали равноправно (ED-27)
- [x] 9.3 Добавить бандл в параметризованный список `editor/ui-ts/test/strings.test.ts` («локали равноправны», «все ключи в своём пространстве»)
- [x] 9.4 Гейт «бандл ↔ описание» в обе стороны в `editor/ui-ts/test` (по образцу `editor/core-ts/test/i18nBundles.test.ts`): пути выводятся из `CAMERA_EFFECTS_DESCRIPTION`, тип без строк — красный тест

## 10. Контент и проверка

- [x] 10.1 `content/visuals/manifest.json` — дополнить секцию примером длящегося эффекта (`states`: компонента-состояние героя → `sway`), существующую запись `FireballExploded` оставить как есть
- [x] 10.2 Проверить, что правка манифеста не затронула симуляцию: `worldInit`, golden-эталоны и реплеи не меняются (ASSET-8) — `npm test` из корня без регенерации эталонов
- [ ] 10.3 Прогнать редактор глазами: `npm run dev -w @game-mvp/editor-ui`, завести тряску от взрыва в таблице событий и убедиться, что на диск уходит валидная секция (ED-14, сценарий «Тряска от взрыва без правки JSON»)
- [x] 10.4 `npm run check` из корня (typecheck + lint + test)
- [x] 10.5 `openspec validate camera-effects-authoring --type change --strict`
