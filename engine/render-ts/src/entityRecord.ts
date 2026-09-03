/**
 * Запись сущности в приёмнике доставок и операции над её ПАРОЙ ИНТЕРПОЛЯЦИИ
 * (REND-2). Врозь с `ViewBuffer` потому, что это разные вещи: там — приём
 * доставок, каденс и словарь записей, здесь — форма самой записи и три способа
 * её сдвинуть: скольжение на доставленное состояние, схлопывание пары у
 * неизменившейся сущности (частичный кадр, `client-shell` SHELL-3) и курс.
 *
 * Мира здесь нет и быть не может: запись наполняется плоской формой (SHELL-1).
 */
import type { ExtractedTick } from './extractor.js';
import type { EntityView } from './types.js';
import { wrapAngle } from './model/boneControl.js';

/** Внутренняя запись сущности: EntityView плюс интерполяционный буфер. */
export interface EntityRecord extends EntityView {
  prevX: number;
  prevY: number;
  currX: number;
  currY: number;
  prevLevel: number;
  currLevel: number;
  snap: boolean;
  spawned: boolean;
  moving: boolean;
  levelOverride: boolean;
  /** Уровень сущности глазами симуляции (TERR-4) — вход маски тумана (FOW-9). */
  simLevel: number;
  prevFacingYaw: number;
  facingYaw: number;
  aimYaw: number | null;
  states: number;
  motion: number;
  prevMotion: number;
  prevMotionPhase: number;
  currMotionPhase: number;
  /** Фаза полёта последнего доставленного тика; `NaN` — сущность не летит (REND-12). */
  flightPhase: number;
  /** Персональная шкала времени последнего доставленного тика; 1 — обычный темп (REND-38). */
  timeScale: number;
  /**
   * ОТЛОЖЕННАЯ доставка записи (REND-2, design D3): интерполируемые величины,
   * чьё время показа ещё не наступило. Шесть чисел и флаг — ровно те величины,
   * которые кадр интерполирует; всё остальное («последнее доставленное»:
   * статы, флаги, прицел, фазы) отставанию не подчиняется и применяется сразу.
   */
  pendX: number;
  pendY: number;
  pendLevel: number;
  pendMotionPhase: number;
  pendMotion: number;
  pendFacingYaw: number;
  hasPending: boolean;
  /**
   * Статы сущности (HUD-8). Словарь заводится ЛЕНИВО — у сущности без статов
   * его нет вовсе — и переиспользуется между доставками: запись живёт всё время
   * жизни сущности, и пересоздавать словарь на каждый тик значило бы
   * аллоцировать пропорционально числу сущностей.
   */
  stats?: Map<string, number>;
}


/**
 * Пара интерполяции схлопывается: сущность не менялась. Без этого альфа,
 * пробегая 0→1 каждый интервал, дёргала бы её назад в начало прежнего сегмента
 * — то же, что делает сегодня доставка неизменившейся строки, только теперь эта
 * строка не едет вовсе (SHELL-3). Здесь же гаснут кадровые признаки записи:
 * `snap` и `spawned` принадлежат одному показанному шагу.
 */
export function collapsePair(record: EntityRecord): void {
  record.prevX = record.currX;
  record.prevY = record.currY;
  record.prevLevel = record.currLevel;
  record.prevMotionPhase = record.currMotionPhase;
  record.prevMotion = record.motion;
  record.prevFacingYaw = record.facingYaw;
  record.snap = false;
  record.spawned = false;
}

/** Вид сущности доставки по её индексу: `null` — сущность не рисуется. */
export function kindOf(ext: ExtractedTick, i: number): string | null {
  const index = ext.kind[i]!;
  return index < 0 ? null : (ext.kindTable[index] ?? null);
}

/**
 * Интерполяция КУРСА между двумя доставленными тиками по кратчайшей дуге
 * (REND-2). Курс живёт на окружности, и линейная интерполяция через ±π
 * развернула бы сущность длинной стороной — на пол-оборота вместо доли.
 *
 * Функция чистая и живёт здесь, рядом с парой, которую она читает: считает её
 * кадр подсистемы, а не буфер — по альфе своего кадра (SHELL-7).
 */
export function interpolateYaw(prev: number, curr: number, alpha: number): number {
  return prev + wrapAngle(curr - prev) * alpha;
}


/**
 * Пара сдвигается на доставленное состояние: `prev ← curr`, `curr ← доставка`.
 * Скачок больше порога — ТЕЛЕПОРТ: пара схлопывается на доставленное, и кадр
 * рисует его без интерполяции (REND-2), иначе сущность «проехала» бы пол-арены.
 *
 * Общая для обоих путей приёмника: немедленного (доставка вступает в показ
 * сразу) и отложенного (вступает по времени показа) — расходиться правилу
 * телепорта в них не на чем.
 */
export function slidePair(
  record: EntityRecord,
  x: number,
  y: number,
  level: number,
  phase: number,
  motion: number,
  teleportSq: number,
): void {
  const dx = x - record.currX;
  const dy = y - record.currY;
  const teleport = dx * dx + dy * dy > teleportSq;
  record.prevX = teleport ? x : record.currX;
  record.prevY = teleport ? y : record.currY;
  record.prevLevel = teleport ? level : record.currLevel;
  record.prevMotionPhase = teleport ? phase : record.currMotionPhase;
  record.prevMotion = teleport ? motion : record.motion;
  // Вид манёвра — член ПАРЫ, а не величина последнего доставленного тика: его
  // двигает показанный шаг вместе с фазой (REND-12). Отложенная доставка
  // (design D3) поэтому не имеет права поставить его раньше времени показа —
  // иначе вклад прошлого тика считался бы высотой ЕЩЁ НЕ ПОКАЗАННОГО манёвра.
  record.motion = motion;
  record.currX = x;
  record.currY = y;
  record.currLevel = level;
  record.currMotionPhase = phase;
  record.snap = teleport;
  record.spawned = false;
}

/**
 * Курс — пара двух последних ПОКАЗАННЫХ тиков, как позиция (REND-2): `NaN`
 * означает «курс не менять», и стоящая сущность оставляет пару такой, какой она
 * была, — остановка разворачивать юнита не имеет права. На разрыве
 * непрерывности пара схлопывается ровно там же, где схлопывается позиция.
 */
export function slideFacing(record: EntityRecord, facing: number, tickAdvanced: boolean): void {
  const heading = Number.isNaN(facing) ? record.facingYaw : facing;
  if (record.snap || record.spawned) record.prevFacingYaw = heading;
  else if (tickAdvanced) record.prevFacingYaw = record.facingYaw;
  record.facingYaw = heading;
}

/**
 * Доставка в ОТЛОЖЕННЫЙ слот записи (design D3): интерполируемые величины ждут
 * своего времени показа, `prev`/`curr` пока не двигаются.
 */
export function stagePending(record: EntityRecord, ext: ExtractedTick, i: number): void {
  record.pendX = ext.x[i]!;
  record.pendY = ext.y[i]!;
  record.pendLevel = ext.level[i]!;
  record.pendMotionPhase = ext.motionPhase[i]!;
  record.pendMotion = ext.motion[i]!;
  record.pendFacingYaw = ext.facingYaw[i]!;
  record.hasPending = true;
}
