/**
 * Превью зоны захвата (R).
 *
 * Превью зоны захвата — presentation, и только presentation: оно следует за
 * курсором МЕЖДУ тиками (REND-2), а захват симуляция разрешает по `aimDir`
 * того тика, на котором кнопка отпущена. Поэтому сектор живёт здесь, в главном
 * потоке, а не записью `effects` манифеста: у оболочки эффекта нет ни
 * ориентации, ни угла раствора (REND-23).
 *
 * Числа — те же, по которым решает JSON-система `CaptureRelease`: они читаются
 * из `AbilityConfig` prefab'а `Hero` (`captureZoneOf`), а не выписываются здесь
 * второй раз. Разошлись бы — превью обещало бы игроку не то, что проверит тик.
 *
 * О кадре модуль не знает ничего сверх того, что подаёт вход фабрики (собирает
 * его `main.ts`): сцена THREE, документ сцены, прицел кадра, удержание клавиши
 * и доставленное состояние героя. Своей копии этих величин он не держит —
 * второй источник истины о кадре разъезжался бы с первым молча.
 */
import * as THREE from 'three';
import type { SceneDef } from '@game-mvp/core';
import { TURN_UNITS } from '@game-mvp/client';
import type { EntityView, ModelInstanceView } from '@game-mvp/render';
import { STATS, captureZoneOf, stateBit } from './sim.js';

/** Подъём над полом: без него сектор тонет в ступени террейна (REND-7). */
const CAPTURE_PREVIEW_LIFT = 0.05;
/**
 * Шаг дуги сектора, радианы. Дуга рисуется вписанным многоугольником, то есть
 * НЕМНОГО у́же настоящего круга; при шаге в градус стрелка сегмента —
 * `R · (1 − cos(шаг/2))`, на радиусе 3 клетки это 0.1 мм мира. Ошибку выбран
 * знак «внутрь»: превью, обещающее меньше реальной зоны, не врёт игроку.
 */
const CAPTURE_PREVIEW_ARC_STEP = Math.PI / 180;

/** Бит состояния «снаряд в руках» доставленной маски (CAM-6, `sim.ts`). */
const HOLDING_STATE = stateBit('Holding');
/** Бит состояния «копит заряд каста»: во время заряда захват тоже не сработает. */
const CHARGING_STATE = stateBit('Charging');
/** Имя доставленного стата кулдауна захвата (HUD-8) — то же, что у панели HUD. */
const CAPTURE_COOLDOWN_STAT = STATS.cooldown('capture');

/**
 * Сектор в плоскости XY: вершина в начале координат, раствор вокруг оси +X.
 * Ровно та фигура, которую проверяет `CaptureRelease`, — круг радиуса `radius`
 * (`withinRadius`), пересечённый клином `dot(normalize(p − герой), aim) ≥
 * cos(halfAngle)`. Треугольный веер от вершины и есть это пересечение: клин
 * даёт две прямые кромки, круг — дугу между ними.
 */
function captureSectorGeometry(radius: number, halfAngleTurns: number): THREE.BufferGeometry {
  const half = halfAngleTurns * Math.PI * 2;
  const segments = Math.max(8, Math.ceil((2 * half) / CAPTURE_PREVIEW_ARC_STEP));
  const positions: number[] = [0, 0, 0];
  for (let i = 0; i <= segments; i++) {
    const angle = -half + (2 * half * i) / segments;
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  }
  const index: number[] = [];
  for (let i = 1; i <= segments; i++) index.push(0, i, i + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/** Вход превью: сцена, числа зоны и покадровые доступы к состоянию сборки. */
export interface CapturePreviewOptions {
  /** Сцена THREE, в которую садится меш сектора. */
  readonly scene: THREE.Scene;
  /** Документ сцены: числа зоны читает из него `captureZoneOf`. */
  readonly sceneDef: SceneDef;
  /**
   * Удержана ли клавиша захвата. Берётся у `KeyboardMouseSource` — у той же
   * истины, из которой бит уезжает в тик (INP-2), а не у собственного набора
   * клавиш: у источника есть сброс по потере фокуса, и alt-tab с зажатой `R`
   * не оставляет сектор нарисованным.
   */
  readonly captureHeld: () => boolean;
  /** Прицел ЭТОГО кадра (`main.ts`); null — луч прошёл мимо пола. */
  readonly frameAim: () => number | null;
  /** Инстанс героя в кадре подсистемы моделей; null — рисовать ещё нечего. */
  readonly heroInstance: () => ModelInstanceView | null;
  /** Доставленное состояние героя (HUD-1); undefined — доставки ещё нет. */
  readonly heroView: () => EntityView | undefined;
  /** Точка пола под инстансом — общая визуальная поверхность кадра (REND-9). */
  readonly groundUnder: (instance: ModelInstanceView) => { x: number; y: number; z: number };
}

/** Ручка превью: `main.ts` зовёт `update` после кадра подсистем. */
export interface CapturePreview {
  update(): void;
}

/**
 * Меш превью появляется в `main`, а не на загрузке модуля: числа зоны читаются
 * из сцены и отсутствие поля — жёсткая ошибка (`captureZoneOf`), а брошенная на
 * верхнем уровне модуля она унесла бы с собой всю страницу — включая кнопку
 * смены режима, единственную дорогу со сломанной страницы.
 */
export function createCapturePreview(options: CapturePreviewOptions): CapturePreview {
  const zone = captureZoneOf(options.sceneDef);
  const mesh = new THREE.Mesh(
    captureSectorGeometry(zone.radius, zone.halfAngleTurns),
    new THREE.MeshBasicMaterial({
      color: 0x8affc8,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.visible = false;
  options.scene.add(mesh);

  return {
    /**
     * Кадр превью: видно, пока зажата клавиша захвата и захват ВОЗМОЖЕН.
     *
     * Гасится по ДОСТАВЛЕННОМУ состоянию (HUD-1): неостывший кулдаун и снаряд
     * уже в руках — два случая, в которых `CaptureRelease` не сработает, и
     * рисовать в них зону значило бы обещать игроку захват, которого не будет.
     */
    update(): void {
      const instance = options.heroInstance();
      const hero = options.heroView();
      const aim = options.frameAim();
      const onCooldown = (hero?.stats?.get(CAPTURE_COOLDOWN_STAT) ?? 0) > 0;
      const blocked = ((hero?.states ?? 0) & (HOLDING_STATE | CHARGING_STATE)) !== 0;
      if (!options.captureHeld() || onCooldown || blocked || instance === null || aim === null) {
        mesh.visible = false;
        return;
      }
      const ground = options.groundUnder(instance);
      mesh.visible = true;
      mesh.position.set(ground.x, ground.y, ground.z + CAPTURE_PREVIEW_LIFT);
      mesh.rotation.set(0, 0, (aim / TURN_UNITS) * Math.PI * 2);
    },
  };
}
