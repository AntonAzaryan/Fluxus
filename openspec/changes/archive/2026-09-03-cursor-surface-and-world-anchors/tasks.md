# Tasks: cursor-surface-and-world-anchors

## 1. Проекция курсора на визуальную поверхность (REND-42, REND-15)

- [x] 1.1 `engine/render-ts/src/cursorSurface.ts`: `CursorSurface` — луч из позы и точки вьюпорта (`ray`), попадание в поверхность как min-t террейн-марша и walkable-рейкаста (`pickRay`, `project`). Своя камера с мировым верхом; аллокаций на кадр нет.
- [x] 1.2 `picking.ts`: `ViewportPicking` строится на `CursorSurface` — своих камеры, марша и `pickSurfaceRay` у него не остаётся; поведение и порядок разрешения не меняются.
- [x] 1.3 Экспорты `index.ts`; тесты `picking.test.ts` (прежние зелёные) плюс новые: плато уровня 1, клетка с кривизной, настил, промах.

## 2. Мировые якоря инстансов (REND-41)

- [x] 2.1 `engine/render-ts/src/screenAnchors.ts`: `ScreenAnchors` — набор названных потребителем сущностей, покадровый пересчёт в заведённые записи, публикация NDC/пикселей/расстояния/признака «виден».
- [x] 2.2 Высота якоря: верх границ × масштаб набора по умолчанию, величина потребителя — вместо него. Вертикальность (наклон и курс не вращают).
- [x] 2.3 Экспорты `index.ts`; тест `screenAnchors.test.ts` — проекция, невидимая сущность, ненарисованная сущность, отсутствие аллокаций на кадр, DOM-граница (REND-19).

## 3. Размещение виджета HUD по мировому якорю (HUD-10, HUD-3)

- [x] 3.1 `hud-ts`: порт `HudAnchorSource`/`HudScreenAnchor` и поле `anchor` записи композиции (слот сущности + смещение), резолв в `registry.ts`.
- [x] 3.2 `HudOverlayHost`: якорный слой поверх зон, `placeAnchored`.
- [x] 3.3 `HudRuntime`: монтирование якорных записей, покадровое размещение по опубликованному якорю, скрытие без якоря; отсутствие источника — скрытый виджет, а не отказ.
- [x] 3.4 Тесты `hud-ts` — размещение, скрытие, тот же виджет в зоне, отсутствие источника.

## 4. Демо: прицел и полоса над героем

- [x] 4.1 `game/demo-ts/app/main.ts`: `aimAtPointer` идёт `CursorSurface` по позе последнего кадра; плоскость `groundPlane` и её `Raycaster` сняты.
- [x] 4.2 Мини-подсистема якорей: регистрация сразу после моделей, пересчёт по позам этого кадра.
- [x] 4.3 `app/hud.ts`: полоса здоровья героя — записью композиции по якорю; источник якорей уходит в `HudRuntime`.
- [x] 4.4 Тесты демо: композиция резолвится, якорная запись объявлена; прицел по поверхности.

## 5. Камера: снап высоты и явное открепление (CAM-5, CAM-8)

- [x] 5.1 `camera/rig.ts`: `advanceFollow` возвращает решение «прыгнула», `advanceGroundHeight` снапает по нему; free и fly Z не прыгают.
- [x] 5.2 `camera/input.ts`: `CameraInput.detach` — фронт; `resetCameraInput` его гасит. `applyModeTransitions`: открепление переводит follow → free, разовые перелёты не гасит.
- [x] 5.3 `edgePanAxes` пишет в запись вызывающего (REND-26).
- [x] 5.4 Демо: `PAN_DETACH_PX` и `pendingPan` сняты, `panTo` откепляет и кадрирует тем же кадром; `cameraInput.ts` заводит поле.
- [x] 5.5 Тесты `camera.test.ts` — Z под флагами snap в follow и free, открепление, edge-pan в запись.

## 6. Отладочный слой: снос, клетка на поверхности, аллокации (F-9)

- [x] 6.1 `engine/render-ts/src/surfaceCells.ts`: общее правило дробления клетки/прямоугольника по визуальной поверхности; `subsystems/overlaySurface.ts` берёт его вместо своего условия.
- [x] 6.2 `debug/painter.ts`: `polygon` дробит треугольники веера по правилу и сэмплирует поле; `dispose()` отдаёт носители и растровые плашки.
- [x] 6.3 `debug/layer.ts`: `RenderDebugLayer.dispose()`.
- [x] 6.4 Тесты: `debug.test.ts` — полигон по кривизне и снос слоя; `lifetime.test.ts` — владелец `debug` в инварианте PERF-9.

## 7. Пресет качества против объявляемого (QUAL-1)

- [x] 7.1 `quality.ts`: `validateQualityPreset(doc, knobs, declarable?)` и `QualityController.validateAgainst(declarable)`.
- [x] 7.2 Демо: перечень объявляемых владельцев (`fog`), валидация им; тест `demoQuality.test.ts` — `performance` не отвергается сценой без тумана.
- [x] 7.3 Тест `quality.test.ts` — принятая ручка непостроенного владельца, отказ по опечатке построенного, пустой перечень.

## 8. Ворота

- [x] 8.1 `npm run check:impact` по группам.
- [x] 8.2 `openspec validate --specs --strict`, `npm run spec-graph -- check`.
- [ ] 8.3 Полный `npm run check`; строка roadmap в `docs/architecture.md`.
