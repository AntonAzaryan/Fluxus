/**
 * Прогрев транзиентных эффектов (REND-23) — вынесенная механика
 * `EffectsSubsystem.prewarm`, парная `particlePrewarm.ts`: перечисление записей
 * манифеста и отбор ПРИМИТИВОВ, под которые греются узлы. Сам узел строит
 * подсистема — пул, группа и материалы её собственность.
 *
 * Прогрев нужен ровно за тем же, за чем он нужен моделям: пул эффектов пуст до
 * первой вспышки, и первый `FireballExploded` компилирует программу
 * `MeshBasicMaterial{transparent}` прямо в кадре боя (замеры шапки
 * `game/demo-ts/app/prewarm.ts` — 95–147 мс ожидания линковки). Ступень здесь
 * одна, в отличие от моделей: ассетов у эффектов нет и ждать нечего.
 */
import { isEffectList, type VisualEffect, type VisualManifest } from '@fluxus/assets';
import type * as THREE from 'three';
import { EMPTY_PREWARM_BATCH, prewarmBatch, type SubsystemPrewarm } from '../types.js';

/**
 * По одной записи на КАЖДЫЙ примитив манифеста, в документном порядке таблиц.
 * Греется примитив, а не запись: цвет и альфа — уносы материала, а программу
 * задаёт материал вместе с геометрией, и она у всех сфер одна.
 */
export function effectPrimitives(manifest: VisualManifest): readonly VisualEffect[] {
  const effects = manifest.effects;
  const seen = new Set<string>();
  const records: VisualEffect[] = [];
  for (const table of [effects?.byKind, effects?.byState, effects?.byEvent]) {
    if (table === undefined) continue;
    for (const entry of Object.values(table)) {
      // Значение таблицы — одна запись либо список (REND-23): греются ВСЕ его
      // изображения, иначе второе из них компилирует свою программу в кадре.
      for (const record of isEffectList(entry) ? entry : [entry]) {
        if (seen.has(record.primitive)) continue;
        seen.add(record.primitive);
        records.push(record);
      }
    }
  }
  return records;
}

/**
 * Прогрев по перечню примитивов: узел берётся у подсистемы (`acquire`) и
 * возвращается ей же по `finish()`. Неизвестный примитив узла не даёт —
 * `acquire` говорит об этом один раз и отдаёт null, как и в кадре.
 */
export function warmEffectNodes<N extends { readonly mesh: THREE.Object3D }>(
  records: readonly VisualEffect[],
  acquire: (record: VisualEffect) => N | null,
  release: (node: N) => void,
): SubsystemPrewarm {
  const warmed: N[] = [];
  for (const record of records) {
    const node = acquire(record);
    if (node !== null) warmed.push(node);
  }
  return {
    // Первая ступень (REND-45): корни вне сцены — по одному на примитив
    // манифеста. Рисовать их нельзя.
    first: prewarmBatch({ roots: warmed.map((node) => node.mesh) }),
    // Второй ступени у эффектов нет: ассетов у них нет и ждать нечего.
    settled: Promise.resolve(EMPTY_PREWARM_BATCH),
    // Идемпотентно (REND-45): повторный `finish` возвращать уже нечего —
    // список опустошён первым.
    finish: () => {
      for (const node of warmed) release(node);
      warmed.length = 0;
    },
  };
}
