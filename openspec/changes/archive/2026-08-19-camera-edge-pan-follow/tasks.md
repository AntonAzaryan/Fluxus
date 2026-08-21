# Tasks: camera-edge-pan-follow

## 1. Спека

- [x] 1.1 Дельта `camera`: CAM-2 — освобождение двусмысленного источника панорамы от открепления в follow, сценарий «Прицел в край не откепляет камеру», требование сохранить хотя бы один однозначный источник
- [x] 1.2 `openspec validate camera-edge-pan-follow --strict` и `npm run spec-graph -- check` зелёные

## 2. Сборка демо (уже реализовано)

- [x] 2.1 `game/demo-ts/app/cameraInput.ts`: край экрана гасится в follow и под интерактивом HUD; стрелки и drag откепляют по-прежнему
- [x] 2.2 `game/demo-ts/test/demoCamera.test.ts`: режим после кадров с курсором в краевой полосе остаётся follow; раздел управления README описывает поведение
