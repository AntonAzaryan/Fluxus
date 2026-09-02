# Tasks: entity-presentation-timescale

## 1. Доставка шкалы до кадра (D1)

- [x] 1.1 Колонка `timeScale: Float32Array` в `ExtractedTick` (`engine/render-ts/src/extractor.ts`): заполнение через `hasComponent(TIME_SCALE_COMPONENT) → getField / FIXED_ONE`, иначе 1; `ensureCapacity` и конструктор `out`; проверка — новый тест экстрактора: сущность со шкалой даёт значение, без — 1 (не 0).
- [x] 1.2 Поле `timeScale: number` в `EntityView` (`types.ts`) и `EntityRecord` (`viewBuffer.ts`): величина последнего доставленного тика, дефолт 1 в `spawnRecord`; проверка — тест `viewBuffer.test.ts` на протаскивание значения и дефолт.
- [x] 1.3 Кодек канала (`engine/client-ts/src/codec.ts`): `F32_COLUMNS` 6 → 7, колонка в хвост f32-секции, комментарии секции; проверка — `codec.test.ts` roundtrip с ненулевой шкалой в фикстуре.

## 2. Анимация моделей (D2)

- [x] 2.1 Контракт `AnimationBackend.update(dt, pace)` и `AnimationController.update(dt, pace)` (`model/animation.ts`): `MixerAnimationBackend` ставит `action.timeScale = direction * pace` (перезапись по изменению значения), микшер идёт `mixer.update(|dt|)`; проверка — тест: фаза клипа при pace 0.5 растёт вдвое медленнее, кроссфейд завершается за штатную длительность при pace 0.2.
- [x] 2.2 `VatAnimationBackend` (`model/vatAnimation.ts`): `advancePhase(clip, dt * pace)`, `fadeLeft` — по `|dt|` без множителя; проверка — тест паритета ярусов: та же фаза при том же pace, развязки one-shot (конец вперёд / начало назад) не сломаны.
- [x] 2.3 `models.ts` `poseRecord`: `record.controller?.update(dt, view.timeScale)`; сглаживания (доворот, наклон, tier-fade) остаются на `settle = |dt|`; проверка — существующие тесты `models`/`locomotion` зелёные, новый тест: замедленная сущность анимируется медленнее, обратная перемотка масштабируется.

## 3. Частицы (D3)

- [x] 3.1 `stepInstance(instance, delta)` в `particleEffects.ts`: структурный тип `{ update(delta: number): void }` поверх рантайм-метода, `typeof`-гард с предупреждением один раз; проверка — юнит-тест: шаг экземпляра двигает эмиссию (`instanceParticles` > 0), падает при смене API библиотеки.
- [x] 3.2 `particles.ts` `updateFrame`: вместо `batchRenderer.update(dt)` — по-эмиттерный шаг (оболочки сущностей `max(dt,0) * view.timeScale`; decoration и выстрелы `max(dt,0)`), затем `batch.update()` по `batchRenderer.batches`; порядок кадра (позы → matrixWorld → шаг → батчи → сбор выстрелов) сохранён; проверка — существующие тесты частиц зелёные, новые: оболочка замедленной сущности эмитирует медленнее, decoration и выстрел — в обычном темпе, `batchCount` не растёт от разных темпов.

## 4. Спека и гейт

- [x] 4.1 Цитаты REND-38 в комментариях новых мест кода (экстрактор, бэкенды, частицы) — `npm run spec-graph -- code REND-38` находит их, `spec-graph check` зелёный.
- [x] 4.2 `npm run check` из корня целиком зелёный; cost-эталоны без диффа (ожидание D4) — при красном диффе сперва разбор причины, `golden:cost` только осознанно; поведенческие `*.golden.json` не тронуты.

## 5. Потребитель-доказательство (демо)

- [x] 5.1 Проверка на демо-сцене: тест уровня render/integration — герой с `TimeScale.value = 0.2` (как под `bossFieldAura`) анимируется в 0.2 темпа; глазами — `npm run demo`, зайти в поле босса.
