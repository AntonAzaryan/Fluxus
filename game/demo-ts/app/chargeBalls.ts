/**
 * Шары заряда каста (ЛКМ).
 *
 * Заряд растёт МЕЖДУ тиками, а радиус оболочки `effects.byKind` задан записью
 * манифеста и один на весь визуальный тип (REND-23) — растить им шар нечем.
 * Поэтому шар живёт здесь, рядом с превью зоны захвата и по тем же правилам:
 * числа — из `AbilityConfig` (`chargeVisualOf`) и из записей манифеста, поза —
 * интерполированная поза инстанса.
 *
 * Шар рисуется КАЖДОЙ доставленной сущности со статом `charge`, а не одному
 * своему герою: соперник копит те же 78 тиков до 400 урона, и заряд без
 * телеграфа означал бы удар, которого не видно, — а видеть его игрок обязан из
 * доставленного состояния (HUD-1), а не из догадки. Направление своего шара —
 * прицел ЭТОГО кадра (курсор идёт впереди тика), чужого — доставленный курс
 * `aimYaw`, который сцена шлёт событием `ChargeAim` каждый тик заряда.
 *
 * Величина заряда приезжает доставленным статом `charge` (`Charging.ticks`), то
 * есть из симуляции: главный поток её не считает и о нажатиях не помнит.
 *
 * Всё, что модуль знает о кадре, подаёт вход фабрики (собирает его `main.ts`):
 * сцена THREE, документ сцены, манифест и покадровые доступы к доставке, к
 * инстансам моделей и к прицелу. Своей копии этих величин он не держит.
 */
import * as THREE from 'three';
import type { EntityId, SceneDef } from '@game-mvp/core';
import { resolveEffectByKind, type VisualEffect, type VisualManifest } from '@game-mvp/assets';
import { TURN_UNITS } from '@game-mvp/client';
import type { EntityView, ModelInstanceView } from '@game-mvp/render';
import { STATS, chargeHeld, chargeVisualOf } from './sim.js';

/**
 * Числа картинки шара — из записей манифеста `effects.byKind`. Отсутствие
 * записи или поля — громкая ошибка, как и дыра в `AbilityConfig`
 * (`captureZoneOf`, `chargeVisualOf`): молчаливое умолчание здесь было бы
 * ТРЕТЬЕЙ копией чисел манифеста, которая расходится с ним незаметно.
 */
interface ChargeBallLook {
  /** Цвет обычного снаряда и цвет тяжёлого: с порога `heavyScale` шар красится вторым. */
  readonly color: string;
  readonly heavyColor: string;
  /** Радиус и высота — снаряда, который улетит при нулевом заряде. */
  readonly radius: number;
  readonly height: number;
  readonly alpha: number;
}

function chargeEffectOf(manifest: VisualManifest, kind: string): VisualEffect {
  const record = resolveEffectByKind(manifest, kind);
  if (record === undefined) {
    throw new Error(
      `демо: в манифесте нет записи effects.byKind.${kind} — шар заряда рисовать нечем`,
    );
  }
  return record;
}

/** Вход шаров: сцена, числа заряда и покадровые доступы к состоянию сборки. */
export interface ChargeBallsOptions {
  /** Сцена THREE, в которую садятся меши шаров. */
  readonly scene: THREE.Scene;
  /** Документ сцены: тайминг и размеры читает из него `chargeVisualOf`. */
  readonly sceneDef: SceneDef;
  /** Манифест визуалов: цвет, базовый радиус и высоту дают записи `effects.byKind`. */
  readonly manifest: VisualManifest;
  /** Доставленные сущности кадра (HUD-1); undefined — доставки ещё нет. */
  readonly entities: () => ReadonlyMap<EntityId, EntityView> | undefined;
  /** Инстанс сущности в кадре подсистемы моделей; null — рисовать ещё нечего. */
  readonly instanceFor: (entity: EntityId) => ModelInstanceView | null;
  /** Сущность своего героя (handshake воркера); null — handshake ещё не пришёл. */
  readonly heroId: () => EntityId | null;
  /** Последний НЕПУСТОЙ прицел кадра (`main.ts`) — направление своего шара. */
  readonly lastAim: () => number | null;
  /** Точка пола под инстансом — общая визуальная поверхность кадра (REND-9). */
  readonly groundUnder: (instance: ModelInstanceView) => { x: number; y: number; z: number };
}

/** Ручка шаров: `main.ts` зовёт `update` после кадра подсистем. */
export interface ChargeBalls {
  update(): void;
}

/**
 * Шары заряда собираются ПОСЛЕ манифеста: цвет, базовый радиус и высоту они
 * берут из записей `effects.byKind.Fireball`/`HeavyFireball`, то есть у тех
 * самых снарядов, один из которых и улетит.
 */
export function createChargeBalls(options: ChargeBallsOptions): ChargeBalls {
  const visual = chargeVisualOf(options.sceneDef);
  const base = chargeEffectOf(options.manifest, 'Fireball');
  const heavy = chargeEffectOf(options.manifest, 'HeavyFireball');
  if (base.alpha === undefined || base.height === undefined) {
    throw new Error(
      'демо: в записи effects.byKind.Fireball нет alpha/height — шар заряда рисовать нечем',
    );
  }
  const look: ChargeBallLook = {
    color: base.color,
    heavyColor: heavy.color,
    radius: base.radius,
    height: base.height,
    alpha: base.alpha,
  };
  /** Геометрия одна на все шары — единичная сфера: размер даёт `scale` меша. */
  const geometry = new THREE.SphereGeometry(1, 20, 14);
  /** Живые шары по сущности и пул снятых: заряжающих на арене единицы. */
  const balls = new Map<EntityId, THREE.Mesh>();
  const pool: THREE.Mesh[] = [];
  /** Кто заряжает в ЭТОМ кадре — переиспользуется, чтобы кадр не аллоцировал. */
  const chargingSeen = new Set<EntityId>();

  /** Меш из пула либо новый; материал свой у каждого — цвет и альфа пер-инстансны. */
  const acquire = (): THREE.Mesh => {
    const pooled = pool.pop();
    if (pooled !== undefined) {
      pooled.visible = true;
      return pooled;
    }
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    );
    mesh.name = 'charge-ball';
    options.scene.add(mesh);
    return mesh;
  };

  const release = (mesh: THREE.Mesh): void => {
    mesh.visible = false;
    pool.push(mesh);
  };

  return {
    /**
     * Кадр шаров заряда: по шару на каждую доставленную сущность со статом
     * `charge`. Размер — линейный рост до `chargeMaxScale` за `chargeTicks`; с
     * порога `chargeHeavyScale` шар перекрашивается в цвет `HeavyFireball` —
     * того самого prefab'а, который родится на отпускании, — а после максимума
     * не растёт, а мигает: предупреждение о перезаряде, который сейчас рванёт в
     * самом кастере (`ChargeOvercharge`).
     */
    update(): void {
      const entities = options.entities();
      chargingSeen.clear();
      if (entities !== undefined) {
        const { ticks: maxTicks, maxScale, heavyScale, offset } = visual;
        const hero = options.heroId();
        const ownAim = options.lastAim();
        // Мигание — по часам кадра, одинаковое для всех шаров: заряд перезрел.
        const blink = Math.floor(performance.now() / 90) % 2 === 0;
        for (const [entity, view] of entities) {
          const ticks = view.stats?.get(STATS.charge);
          if (ticks === undefined) continue;
          const instance = options.instanceFor(entity);
          if (instance === null) continue;
          // Свой шар целится прицелом кадра: курсор идёт впереди тика. Последним
          // НЕПУСТЫМ, а не текущим, — луч, ушедший мимо плоскости пола, не повод
          // гасить шар, пока заряд идёт к взрыву в кастере (то же правило, что у
          // сэмплера, INP-5). Чужой — доставленным курсом `ChargeAim`.
          const own = entity === hero ? ownAim : null;
          const angle =
            own === null ? (view.aimYaw ?? view.facingYaw) : (own / TURN_UNITS) * Math.PI * 2;
          const held = chargeHeld(ticks, maxTicks);
          const scale = 1 + (maxScale - 1) * (held / maxTicks);
          const ground = options.groundUnder(instance);
          let ball = balls.get(entity);
          if (ball === undefined) {
            ball = acquire();
            balls.set(entity, ball);
          }
          chargingSeen.add(entity);
          ball.scale.setScalar(look.radius * scale);
          ball.position.set(
            ground.x + Math.cos(angle) * offset,
            ground.y + Math.sin(angle) * offset,
            ground.z + look.height,
          );
          const material = ball.material as THREE.MeshBasicMaterial;
          material.color.set(scale >= heavyScale ? look.heavyColor : look.color);
          // Альфа записи МОДУЛИРУЕТСЯ, а не подменяется: число прозрачности живёт
          // в манифесте, здесь — только «мигает или нет». Передержка видна в СЫРЫХ
          // тиках: `chargeHeld` обрезает их окном роста ровно как `ChargeRelease`.
          const overcharged = ticks - 1 >= maxTicks;
          material.opacity = overcharged && blink ? look.alpha * 0.4 : look.alpha;
        }
      }
      for (const [entity, ball] of balls) {
        if (chargingSeen.has(entity)) continue;
        release(ball);
        balls.delete(entity);
      }
    },
  };
}
