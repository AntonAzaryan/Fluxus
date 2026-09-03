/**
 * Канал тинта инстанса (REND-40): цвет и сила, которыми кадр красит уже
 * нарисованный инстанс, — цвет команды, подсветка, вспышка попадания.
 *
 * ## Что такое тинт
 *
 * Тинт — МНОЖИТЕЛЬ цвета: нарисованный цвет умножается на `mix(белый, цвет,
 * сила)`. Сила ноль — множитель единичный, и инстанс без тинта рисуется байт в
 * байт как рисовался бы без канала вовсе; сила единица — множителем становится
 * сам цвет. Множитель, а не подмена, потому что тинт обязан оставить читаемой
 * саму модель: команда узнаётся по оттенку, а не по тому, что все юниты стали
 * плоскими цветными силуэтами.
 *
 * ## Две подачи одного канала
 *
 * Подач у канала две, и живут они на записи рядом:
 *
 * - **база** — то, что поставил порт (`setTint`): цвет команды, подсветка. Сама
 *   не гаснет;
 * - **вспышка** — таблица `byEvent` записи манифеста (ASSET-18): событие
 *   доставки зажигает её на свою длительность, и она линейно спадает К БАЗЕ, а
 *   не к «без тинта». Юнит команды, получивший урон, мигает и возвращается к
 *   цвету команды, а не к серому.
 *
 * Нарисованное кадром — сведение этих двух, и считается оно на месте, в полях
 * той же записи: аллокаций на инстанс на кадр у канала нет (REND-26).
 *
 * ## Ярусы
 *
 * Оба яруса (REND-20) красят одними числами и по одной формуле, различаясь
 * только исполнением: батчевый несёт `(r, g, b, сила)` пер-инстансным
 * атрибутом `instanceTint` (`model/batch.ts`, `model/vatMaterial.ts`),
 * детальный пишет тот же множитель в `color` СВОИХ материалов (copy-on-write
 * REND-6) — переводя их в собственные ровно тогда, когда тинт впервые
 * ненулевой, чтобы не покрасить соседей по разделяемому материалу ассета.
 *
 * Маска команд-цвета — индексы материалов модели (ASSET-18): у батча она
 * компилируется в материал батча, у детального яруса выбирает материалы, в
 * которые пишется множитель. Индекс материала — то, что у обоих ярусов
 * одинаково, поэтому маской он и служит.
 */
import * as THREE from 'three';
import type { EntityVisual } from '@fluxus/assets';
import type { ModelInstance } from '../../model/build.js';

/**
 * Состояние канала на записи (REND-40). Одна структура на инстанс, заводится
 * при его создании и переиспользуется: кадр только переписывает числа.
 */
export interface InstanceTint {
  /** База — то, что поставил порт; не гаснет сама. */
  baseR: number;
  baseG: number;
  baseB: number;
  baseStrength: number;
  /** Вспышка события (ASSET-18) и её часы: остаток и полная длительность. */
  flashR: number;
  flashG: number;
  flashB: number;
  flashStrength: number;
  flashLeft: number;
  flashSeconds: number;
  /** Сведение базы и вспышки — то, чем инстанс нарисован в ЭТОМ кадре. */
  r: number;
  g: number;
  b: number;
  strength: number;
  /**
   * Материалы инстанса уже красились. Нужен затем, чтобы возврат силы к нулю
   * вернул им базовый цвет ОДИН раз, а инстанс, тинта не видевший, не платил за
   * канал ни обходом материалов, ни переводом их в собственные (REND-6).
   */
  painted: boolean;
}

/**
 * Вход порта «цвет на сущность» (REND-40). Компоненты цвета — в РАБОЧЕМ
 * пространстве рендера: авторская запись «#rrggbb» переводится в него один раз
 * у того, кто владеет палитрой, а не на каждом кадре у того, кто её рисует.
 * Кто такая «команда» и какого она цвета, рендер не знает и знать не должен —
 * это политика игры (`docs/architecture.md` §3).
 */
export interface InstanceTintInput {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Сила тинта [0..1]: ноль — тинта нет, единица — множителем стал сам цвет. */
  readonly strength: number;
}

/** Разложенная вспышка записи манифеста: цвет уже в рабочем пространстве. */
export interface ResolvedFlash {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly strength: number;
  readonly seconds: number;
}

/**
 * Блок тинта записи в разложенном виде (ASSET-18): маска и таблица вспышек.
 * `null` в маске — тинт действует на весь инстанс.
 */
export interface TintEntry {
  readonly materials: readonly number[] | null;
  readonly byEvent: ReadonlyMap<string, ResolvedFlash> | null;
}

/** Запись без тинта — один объект на процесс: ветка «блока нет» без аллокации. */
const NO_TINT: TintEntry = Object.freeze({ materials: [], byEvent: null });

/** Пустое состояние канала: инстанс без тинта (REND-40). */
export function makeTint(): InstanceTint {
  return {
    baseR: 1,
    baseG: 1,
    baseB: 1,
    baseStrength: 0,
    flashR: 1,
    flashG: 1,
    flashB: 1,
    flashStrength: 0,
    flashLeft: 0,
    flashSeconds: 0,
    r: 1,
    g: 1,
    b: 1,
    strength: 0,
    painted: false,
  };
}

/**
 * База канала — вход порта «цвет на сущность» (REND-40). Цвет приходит в
 * рабочем пространстве рендера; перевод из авторской записи делает вызывающий.
 */
export function setBaseTint(tint: InstanceTint, r: number, g: number, b: number, strength: number): void {
  tint.baseR = r;
  tint.baseG = g;
  tint.baseB = b;
  tint.baseStrength = clamp01(strength);
}

/**
 * Вспышка зажжена событием доставки (REND-40, ASSET-18). Повторное событие
 * внутри идущей вспышки перезапускает её с начала: два попадания подряд мигают
 * дважды, а не гаснут по часам первого.
 */
export function armFlash(tint: InstanceTint, flash: ResolvedFlash): void {
  tint.flashR = flash.r;
  tint.flashG = flash.g;
  tint.flashB = flash.b;
  tint.flashStrength = flash.strength;
  tint.flashSeconds = flash.seconds;
  tint.flashLeft = flash.seconds;
}

/**
 * Ход канала за кадр (REND-40): вспышка спадает по МОДУЛЮ часов, как доворот и
 * наклон, — направления у неё нет, и обратный ход мира не должен разгорать её
 * обратно. Сведение считается здесь же и на месте: ни объекта, ни массива на
 * инстанс на кадр (REND-26).
 */
export function advanceTint(tint: InstanceTint, settle: number): void {
  if (tint.flashLeft > 0) tint.flashLeft = Math.max(0, tint.flashLeft - settle);
  const k = tint.flashSeconds > 0 ? tint.flashLeft / tint.flashSeconds : 0;
  if (k <= 0) {
    tint.r = tint.baseR;
    tint.g = tint.baseG;
    tint.b = tint.baseB;
    tint.strength = tint.baseStrength;
    return;
  }
  tint.r = tint.baseR + (tint.flashR - tint.baseR) * k;
  tint.g = tint.baseG + (tint.flashG - tint.baseG) * k;
  tint.b = tint.baseB + (tint.flashB - tint.baseB) * k;
  tint.strength = tint.baseStrength + (tint.flashStrength - tint.baseStrength) * k;
}

/**
 * Тинт на материалы ДЕТАЛЬНОГО инстанса (REND-40, REND-6). Пишется множитель
 * `base × mix(1, цвет, сила)`, а базовый цвет материала запоминается в его
 * `userData`: копия материала — fade-копия (FOW-8), якорь прогрева, своя копия
 * скина — переносит `userData` вместе с цветом, поэтому база не теряется ни на
 * одном из путей копирования.
 *
 * Материалы переводятся в СОБСТВЕННЫЕ при первом же ненулевом тинте: цвет —
 * свойство материала, и запись его в разделяемый материал ассета покрасила бы
 * всех соседей записи (REND-3, REND-6) — тот же довод, по которому copy-on-write
 * делает подмена скина.
 *
 * Пишется в материалы ИНСТАНСА, а не в те, которыми меши нарисованы сейчас:
 * во время эпизода угасания меши держат fade-копии, и копия пересобирается по
 * оригиналу на каждой выдаче (`FadeClonePool.borrow`), — тинт, поставленный
 * внутри эпизода, виден со следующей выдачи, а не с этого кадра. Осознанный
 * остаток: единственная величина, которая внутри эпизода меняется быстро, —
 * вспышка, а угасающий инстанс и без неё уходит из кадра.
 */
export function paintDetailed(
  model: ModelInstance,
  tint: InstanceTint,
  mask: readonly number[] | null,
): void {
  // Запись блока тинта не объявила (ASSET-18) — маска пуста, и канала у неё нет
  // ни на одном ярусе: у батчевого его нет в программе материала, здесь —
  // ни одного материала под покраску. Проверяется ПЕРВЫМ делом, чтобы порт,
  // позванный на такую сущность, не переводил её материалы в собственные
  // (REND-6) ради покраски, которой не будет.
  if (mask !== null && mask.length === 0) return;
  // Инстанс, тинта не видевший и не получивший, канала не замечает вовсе.
  if (!tint.painted && tint.strength <= 0) return;
  if (tint.strength > 0 && !model.ownsMaterials) model.ownTextureTargets();
  const materials = model.materials;
  if (mask === null) {
    for (const material of materials) paintMaterial(material, tint);
  } else {
    for (const index of mask) {
      const material = materials[index];
      if (material !== undefined) paintMaterial(material, tint);
    }
  }
  // Ноль записан — материалы вернулись к базе, и следующий пустой кадр обхода
  // уже не стоит.
  tint.painted = tint.strength > 0;
}

/** Множитель тинта в цвет одного материала; база — из его `userData` (REND-40). */
function paintMaterial(material: THREE.MeshStandardMaterial, tint: InstanceTint): void {
  const base = (material.userData.tintBase as TintBase | undefined) ?? captureBase(material);
  const k = tint.strength;
  material.color.setRGB(
    base.r * (1 + (tint.r - 1) * k),
    base.g * (1 + (tint.g - 1) * k),
    base.b * (1 + (tint.b - 1) * k),
  );
}

/** Базовый цвет материала — снимок ДО первой покраски (REND-40). */
interface TintBase {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function captureBase(material: THREE.MeshStandardMaterial): TintBase {
  const base: TintBase = { r: material.color.r, g: material.color.g, b: material.color.b };
  material.userData.tintBase = base;
  return base;
}

/**
 * Блок тинта записи манифеста в разложенном виде (ASSET-18). Цвета разбираются
 * ОДИН раз на запись, а не на инстанс: всплеск открытия обзора (FOW-8) — это
 * пачка инстансов одной записи за одну доставку, и разбор строки на каждого из
 * них был бы платой ни за что. Кэш ключуется самой записью — правленый документ
 * приносит новые объекты записей (REND-17), а прежние уходят со своими
 * таблицами.
 */
export function resolveTintEntry(visual: EntityVisual | undefined): TintEntry {
  const block = visual?.tint;
  if (visual === undefined || block === undefined) return NO_TINT;
  const cached = resolved.get(visual);
  if (cached !== undefined) return cached;
  let byEvent: Map<string, ResolvedFlash> | null = null;
  for (const [event, flash] of Object.entries(block.byEvent ?? {})) {
    const color = SCRATCH_COLOR.set(flash.color);
    byEvent ??= new Map();
    byEvent.set(event, {
      r: color.r,
      g: color.g,
      b: color.b,
      strength: clamp01(flash.strength ?? 1),
      seconds: flash.seconds,
    });
  }
  const entry: TintEntry = { materials: block.materials ?? null, byEvent };
  resolved.set(visual, entry);
  return entry;
}

/** Разбор цвета записи — один переиспользуемый объект на модуль (REND-26). */
const SCRATCH_COLOR = new THREE.Color();

/** Разложенные блоки тинта по записи манифеста (REND-17, ASSET-18). */
const resolved = new WeakMap<EntityVisual, TintEntry>();

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
