/**
 * Носитель «модели ещё (или уже) нет» (ASSET-4, REND-24): заглушка на время
 * загрузки и вид, изображение которому даёт чужая подсистема — частицы
 * (ASSET-14, REND-37).
 *
 * Оба рисуются не моделью, и оба обязаны отвечать на те же вопросы, что ярусы:
 * где инстанс, каких он габаритов, попадает ли в него picking (REND-15). Общий
 * интерфейс носителя снимает спецслучаи `holder`/`placeholder`/`emitter` из
 * подсистемы: их знает этот модуль, а не она.
 */
import * as THREE from 'three';
import type { ModelBounds } from '../../../model/build.js';
import { own } from '../../../footprint.js';
import type { CarrierDeps, InstanceCarrier, InstanceRecord } from '../instanceRecord.js';
import { applyHolderPose, ensureHolder, releaseHolder } from './support.js';

/**
 * Владелец заглушек в учёте занятой памяти (PERF-8). Отдельный от подсистемы
 * намеренно: заглушки — процессные синглтоны, они переживают снос сцены по
 * построению, и инвариант «после сноса живых ноль» (PERF-9) относится к
 * подсистемам, а не к ним.
 */
const PLACEHOLDER_OWNER = 'placeholders';

const PLACEHOLDER_COLOR = 0xd040d0;
/** Габариты заглушки (ASSET-4) — из них же строится её геометрия. */
const PLACEHOLDER_WIDTH = 0.4;
const PLACEHOLDER_HEIGHT = 0.9;
/**
 * Габариты заглушки в осях инстанса: коробка стоит НА земле, а не в её центре,
 * — тем же преобразованием, что и её геометрия. По ним идут picking (REND-15) и
 * отсечение (REND-21), пока модель не доехала.
 */
const PLACEHOLDER_BOUNDS: ModelBounds = {
  minX: -PLACEHOLDER_WIDTH / 2,
  minY: -PLACEHOLDER_WIDTH / 2,
  minZ: 0,
  maxX: PLACEHOLDER_WIDTH / 2,
  maxY: PLACEHOLDER_WIDTH / 2,
  maxZ: PLACEHOLDER_HEIGHT,
};
/**
 * Габариты вида, который рисуют частицы (ASSET-14, REND-24): попадать в него
 * чем-то надо (REND-15, REND-18), а модели у него нет вовсе. Ширина — как у
 * заглушки, высота — метр: это не изображение эффекта, а объём попадания.
 */
const EMITTER_WIDTH = PLACEHOLDER_WIDTH;
const EMITTER_HEIGHT = 1;
const EMITTER_BOUNDS: ModelBounds = {
  minX: -EMITTER_WIDTH / 2,
  minY: -EMITTER_WIDTH / 2,
  minZ: 0,
  maxX: EMITTER_WIDTH / 2,
  maxY: EMITTER_WIDTH / 2,
  maxZ: EMITTER_HEIGHT,
};

/**
 * Геометрия и материал заглушки — общие на все заглушки процесса: заглушка у
 * них одна и та же (ASSET-4), и пер-инстансного в ней нет ничего. Строятся
 * лениво и не освобождаются вместе с инстансом — иначе следующая заглушка
 * строила бы их заново.
 */
let placeholderGeometry: THREE.BufferGeometry | null = null;
let placeholderMaterial: THREE.MeshStandardMaterial | null = null;

/**
 * Заглушка инстанса (ASSET-4). Геометрия и материал у всех заглушек ОБЩИЕ:
 * пер-инстансного в заглушке нет ничего, а своя пара на инстанс — это лишний
 * буфер и лишний материал на каждую незагруженную модель.
 */
export function attachPlaceholder(record: InstanceRecord, deps: CarrierDeps): void {
  if (placeholderGeometry === null) {
    // Владелец — не подсистема, а «заглушки процесса»: пара живёт дольше
    // любой сцены и любого стенда (ASSET-4), и записывать её на подсистему
    // значило бы, что после сноса у той остаётся живой ресурс (PERF-9).
    const geometry = own(
      'geometry',
      PLACEHOLDER_OWNER,
      new THREE.BoxGeometry(PLACEHOLDER_WIDTH, PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT),
    );
    geometry.translate(0, 0, PLACEHOLDER_HEIGHT / 2); // стоит на земле, а не тонет в ней
    placeholderGeometry = geometry;
  }
  placeholderMaterial ??= own(
    'material',
    PLACEHOLDER_OWNER,
    new THREE.MeshStandardMaterial({ color: PLACEHOLDER_COLOR }),
  );
  const mesh = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
  ensureHolder(record, deps).add(mesh);
  record.placeholder = mesh;
  record.carrier = PLACEHOLDER_CARRIER;
}

/** Носитель заглушки: коробка на держателе записи (ASSET-4). */
const PLACEHOLDER_CARRIER: InstanceCarrier = {
  tier: 'detailed',
  applyPose: applyHolderPose,
  setVisible: (record, visible) => {
    if (record.holder !== null) record.holder.visible = visible;
  },
  selectLod: () => {
    // Уровней у заглушки нет: она одна на все модели (ASSET-4).
  },
  bounds: () => PLACEHOLDER_BOUNDS,
  cullBounds: () => null,
  applySkin: () => {
    // Скин заглушки не касается: своих материалов у неё нет (REND-6).
  },
  detach: (record, deps) => {
    disposePlaceholder(record);
    releaseHolder(record, deps);
  },
};

/**
 * Носитель вида, который рисуют частицы (REND-24, REND-37): этот пул ему не
 * строит ничего и даёт только объём попадания.
 */
export const EMITTER_CARRIER: InstanceCarrier = {
  tier: 'detailed',
  applyPose: () => {
    // Изображение ведёт подсистема частиц по своей позе (REND-24).
  },
  setVisible: () => {
    // Гасить нечего: узла в сцене у эмиттерного вида нет.
  },
  selectLod: () => {
    // Уровней у него нет по той же причине.
  },
  bounds: () => EMITTER_BOUNDS,
  cullBounds: () => null,
  applySkin: () => {
    // Скин эмиттерного вида — дело документа эффекта (ASSET-14).
  },
  detach: () => {
    // Снимать нечего: построенного из ассета у него не было.
  },
};

/**
 * Снимает заглушку с инстанса. Геометрию и материал НЕ освобождает: они общие
 * на все заглушки (см. `attachPlaceholder`), и освобождение здесь погасило бы
 * заглушки всех остальных инстансов.
 */
export function disposePlaceholder(record: InstanceRecord): void {
  if (record.placeholder === null) return;
  record.placeholder.removeFromParent();
  record.placeholder = null;
}
