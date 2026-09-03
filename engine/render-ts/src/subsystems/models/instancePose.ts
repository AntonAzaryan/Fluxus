/**
 * Кинематика кадра инстанса (REND-2, REND-9..REND-13): ГДЕ он стоит, куда
 * смотрит и как наклонён. Чистая функция над записью и визуальной поверхностью
 * — ни ресурсов THREE, ни носителей яруса здесь нет: посчитанное преобразование
 * забирает носитель (`carrier/`), а часы клипа ведёт контроллер.
 *
 * Один расчёт на оба яруса (REND-20): узел детального поддерева и
 * инстанс-матрица батча получают ровно те же числа, а не два похожих счёта.
 */
import type { EntityView } from '../../types.js';
import type { VisualSurface, SurfaceNormal } from '../../visualSurface.js';
import { orientFromTiltYaw, smoothTilt, tiltTarget, type TiltVector } from '../../model/surfaceAlign.js';
import { advanceFall, jumpArc, jumpBase, maneuverEnds, type ManeuverEnds } from '../../model/verticalOffset.js';
import { smoothYaw } from '../../model/boneControl.js';
import { arcHeightOf, isAirborne, type InstanceRecord } from './instanceRecord.js';

// Переиспользуемые между кадрами объекты — аллокаций на инстанс на кадр нет.
const SCRATCH_NORMAL: SurfaceNormal = { x: 0, y: 0, z: 1 };
const SCRATCH_TILT: TiltVector = { x: 0, y: 0 };
const SCRATCH_ENDS: ManeuverEnds = { takeoffX: 0, takeoffY: 0, landingX: 0, landingY: 0 };

/**
 * Поза записи в этом кадре: место, курс, наклон. Пишет `pos`, `quat`, `yaw`,
 * `tilt`, `fallOffset` и снимает `snapPending`; всё прочее — не её дело.
 */
export function poseInstance(
  record: InstanceRecord,
  dt: number,
  settle: number,
  alpha: number,
  heightStep: number,
  turnRate: number,
  tiltRate: number,
  surface: VisualSurface | null,
): void {
  const view = record.view;
  // Интерполяция между двумя последними тиками; snap-тик рисуется без неё (REND-2).
  const t = view.snap ? 1 : alpha;
  const x = view.prevX + (view.currX - view.prevX) * t;
  const y = view.prevY + (view.currY - view.prevY) * t;
  // Walkable-инстанс сажается и наклоняется по террейн-форме — без
  // walkable-вкладов, в том числе чужих: иначе два моста сажались бы друг
  // на друга по кругу (REND-9). Все прочие читают поле целиком — юнит на
  // настиле стоит на настиле (REND-10).
  const walkableSeat = record.decoration && view.walkable === true;
  const base = baseHeightOf(view, t, x, y, heightStep, surface, walkableSeat);
  // Вертикальное смещение — чистое представление (REND-12): дуга манёвра
  // смешивается по тем же двум тикам, что позиция, снижение идёт по кадрам.
  // Высота КАЖДОГО вклада берётся по виду манёвра ЕГО тика: прыжковая
  // высота к уклону не переносится, а тик приземления (манёвра уже нет)
  // доигрывает спуск прошлого тика вместо мгновенного обнуления.
  const arcPrev = jumpArc(view.prevMotionPhase, arcHeightOf(record, view.prevMotion));
  const arcCurr = jumpArc(view.currMotionPhase, arcHeightOf(record, view.motion));
  // Полётная дуга — по фазе полёта плоской формы (REND-12): её приносит
  // сборка воркера (SHELL-2), и без неё дуги нет независимо от манифеста.
  const flightArc = jumpArc(view.flightPhase, record.flightArcHeight);
  if (record.falling) {
    record.fallOffset = advanceFall(record.fallOffset, record.fallSpeed, record.fallDepth, dt);
  }
  record.pos.set(
    x,
    y,
    base + arcPrev + (arcCurr - arcPrev) * t + flightArc + record.fallOffset,
  );

  // Курс: цель из данных тика, доворот сглажен по кадрам; при snap —
  // мгновенно. Поправка на перёд модели — своя у каждой записи (REND-13).
  const targetYaw = view.facingYaw + record.facingOffset;
  record.yaw = record.snapPending
    ? targetYaw
    : smoothYaw(record.yaw, targetYaw, turnRate, settle);

  poseTilt(record, x, y, surface, walkableSeat, tiltRate, settle);
  record.snapPending = false;
  record.posed = true;
  // Ориентация: сперва курс вокруг вертикали, поверх — наклон в мировых
  // осях. Композиция общая с walkable-реестром поля (REND-9): трансформ
  // walkable-поверхности — тот же, каким инстанс нарисован.
  orientFromTiltYaw(record.tilt, record.yaw, record.quat);
}

/**
 * Опорная высота записи в кадре. Сущность на поверхности стоит на визуальной
 * поверхности (рампы и кривизна, REND-9); с override уровня (TERR-4) — на
 * высоте уровня. Летящая — на переходе между высотами отрыва и приземления
 * (REND-12): дискретный уровень под ней в высоте прыжка не участвует, иначе
 * пересечение границы обрыва сдвигало бы инстанс на ступень.
 */
function baseHeightOf(
  view: EntityView,
  t: number,
  x: number,
  y: number,
  heightStep: number,
  surface: VisualSurface | null,
  walkableSeat: boolean,
): number {
  if (surface !== null && isAirborne(view)) {
    // Фаза манёвра до первого его тика — ноль: на том тике манёвра ещё не
    // было, и `prevMotionPhase` пришла как NaN.
    const phasePrev = Number.isFinite(view.prevMotionPhase) ? view.prevMotionPhase : 0;
    const phase = phasePrev + (view.currMotionPhase - phasePrev) * t;
    maneuverEnds(
      x,
      y,
      view.currX - view.prevX,
      view.currY - view.prevY,
      phase,
      view.currMotionPhase - phasePrev,
      SCRATCH_ENDS,
    );
    return jumpBase(
      surface.heightAt(SCRATCH_ENDS.takeoffX, SCRATCH_ENDS.takeoffY),
      surface.heightAt(SCRATCH_ENDS.landingX, SCRATCH_ENDS.landingY),
      phase,
    );
  }
  if (surface !== null && !view.levelOverride) {
    return walkableSeat ? surface.terrainFormHeightAt(x, y) : surface.heightAt(x, y);
  }
  return (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
}

/**
 * Наклон по нормали поверхности (REND-10): только для сущностей на поверхности;
 * сглажен по кадрам, при snap — мгновенно (REND-2).
 */
function poseTilt(
  record: InstanceRecord,
  x: number,
  y: number,
  surface: VisualSurface | null,
  walkableSeat: boolean,
  tiltRate: number,
  settle: number,
): void {
  if (surface === null || record.tiltFactor <= 0 || record.view.levelOverride) {
    record.tilt.x = 0;
    record.tilt.y = 0;
    return;
  }
  if (walkableSeat) surface.terrainFormNormalAt(x, y, SCRATCH_NORMAL);
  else surface.normalAt(x, y, SCRATCH_NORMAL);
  tiltTarget(SCRATCH_NORMAL, record.tiltFactor, record.tiltMaxRad, SCRATCH_TILT);
  if (record.snapPending) {
    record.tilt.x = SCRATCH_TILT.x;
    record.tilt.y = SCRATCH_TILT.y;
    return;
  }
  smoothTilt(record.tilt, SCRATCH_TILT, tiltRate, settle);
}
