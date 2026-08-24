# Proposal: lighting-research-followups

## Why

Исследование стилизованного освещения (`docs/reviews/2026-08-22-lighting-stylized-webgl-threejs.md`) сверено с реализованными REND-29..34; применимые без кода пункты уже применены данными. Остались пять пунктов, требующих правки спек и кода: они закрывают разрыв между текущим светом (ambient + directional) и целевой стилизованной картинкой — объём без теней (hemisphere), отделение силуэтов (rim), дешёвые тени для слабого железа (blob), HDR-emissive под bloom и единый «look» кадра (LUT).

## What Changes

- **Hemisphere-fill** в секции `lighting`: рассеянный свет с двумя тонами (небо/земля), смешиваемыми по нормали поверхности, — дешёвый объём вместо плоской заливки `AmbientLight`. Необязательная подсекция; участвует в фазах цикла суток наравне с ambient.
- **Rim-свет**: необязательный второй направленный источник (цвет, интенсивность, направление) для отделения силуэтов от фона; теней не отбрасывает, в реестр кастеров не входит.
- **Blob-тени**: новый режим теней между `none` и `hybrid` в порядке стоимости — тёмная декаль под динамическими инстансами вместо карт теней; целевой режим performance-пресета на слабом железе/Steam Deck.
- **Emissive strength >1**: чтение `KHR_materials_emissive_strength` в glTF-загрузчике и поле в нормализованном представлении материала — без него HDR-emissive не доезжает до порога bloom (`threshold: 1`).
- **LUT-цветокоррекция**: необязательная подсекция `lut` секции `postprocess` — 3D-таблица цвета, применяемая после tone mapping и строго до маски тумана (FOW-7); единый «look» кадра ценой одного текстурного сэмпла.

Каждый пункт — presentation-слой: на симуляцию, `worldInit` и снапшоты не влияет ни байтом (PRES-4). Каждая новая покадровая стоимость объявляет ручку качества или константность (QUAL-3).

## Capabilities

### New Capabilities

_нет_

### Modified Capabilities

- `rendering`: REND-29 — hemisphere-подсекция и rim-источник в составе секции `lighting`; REND-30 — режим `blob` в словаре теней (`none` < `blob` < `hybrid` < `full`), семантика потолка пресета по тому же рангу; REND-32 — hemisphere и rim в значениях фаз цикла суток; REND-34 — подсекция `lut` и место LUT-прохода в порядке проходов (после tone mapping, до маски тумана).
- `assets`: ASSET-5 — поле силы emissive в нормализованном представлении материала (источник — `KHR_materials_emissive_strength` glTF).

## Impact

- `engine/assets-ts`: валидация новых полей секций `lighting`/`postprocess` (типы `PresentationLighting`, `PresentationPostprocess`), парсинг `KHR_materials_emissive_strength` в `loaders/gltf.ts`, поле в `model.ts`; загрузчик LUT-файла (.cube) — регистрация по ASSET-3, правок ядра модуля не требует.
- `engine/render-ts`: `lighting/config.ts` + `subsystems/lighting.ts` (hemisphere, rim, blob-декали), `lighting/cycle.ts` (фазы), `postprocess/*` (LUT-проход), `model/build.ts` (emissiveIntensity), счётчики стоимости (PERF-2/PERF-3).
- `game/demo-ts`: пресеты качества (потолок `blob` в performance), тест реестра ручек (`demoQuality.test.ts`), при желании — данные сцены `content/scenes/duel.presentation.json`.
- Cost-бейзлайны (`*.cost.json`) меняются только там, где сцена включает новые возможности; сцены без новых полей рисуются байт-в-байт как прежде — умолчания обязаны воспроизводить текущий кадр.
