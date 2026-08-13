/**
 * Подсистема транзиентных эффектов (REND-23): короткоживущие изображения
 * поверх сцены, у которых нет модели в манифесте инстансов, — оболочка щита,
 * шарик снаряда, вспышка взрыва, превью зоны.
 *
 * Отдельная подсистема за общим контрактом (REND-8), а не ветка в подсистеме
 * моделей: у эффекта нет ни модели, ни ассетов, ни анимационного графа —
 * общего с инстансом у него только место в кадре. Кусок маленький и заменяемый:
 * появится настоящая система частиц — она встанет сюда же, не трогая моделей.
 *
 * Два источника, и оба — уже ДОСТАВЛЕННОЕ presentation-состояние (REND-23):
 *
 * - **оболочка** (`effects.byKind`): живёт, пока в доставленном состоянии есть
 *   сущность такого визуального типа. Собственного состояния у неё нет —
 *   исчезла сущность, исчезла оболочка, и восстановленное перемоткой состояние
 *   воспроизводит её само (REND-2);
 * - **вспышка** (`effects.byEvent`): reliable-событие тика запускает её на
 *   `durationMs`, и фаза жизни идёт по ЧАСАМ КАДРА главного потока (SHELL-7),
 *   а не по тикам: события не тикают, а доставка их только переносит. Разрыв
 *   непрерывности (REND-2) вспышки гасит — доигрывать через перемотку нечего.
 *
 * Параметры — примитив, цвет, альфа, радиусы, длительность, кривая — данные
 * манифеста (REND-23, REND-4: реакция на событие — данные). Новый эффект есть
 * запись в JSON, и код этого модуля от неё не меняется. Имена примитивов и
 * кривых называет ЭТОТ код (перечень принадлежит рендеру, ASSET-8-образно):
 * неизвестное имя — предупреждение один раз и пропуск, а не отказ кадра.
 *
 * Геометрия примитива разделяется всеми эффектами (REND-3), пер-инстансны
 * только материал и трансформ; меши берутся из пула и в него возвращаются —
 * аллокаций на кадр, растущих с числом эффектов, нет.
 *
 * Симуляции подсистема не читает (её вход — `TickView`, как у всех), в picking
 * не участвует (REND-15): источника прокси она не реализует, и попасть лучом в
 * эффект нельзя по построению — эффект есть изображение, а не сущность.
 */
import * as THREE from 'three';
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import {
  resolveEffectByEvent,
  resolveEffectByKind,
  type VisualEffect,
  type VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { jumpArc } from '../model/verticalOffset.js';

/** Примитивы, которые умеет рисовать подсистема; перечень принадлежит рендеру. */
const PRIMITIVE_SPHERE = 'sphere';

/** Кривые фазы жизни; неизвестное имя — предупреждение и линейная кривая. */
const CURVE_LINEAR = 'linear';
const CURVE_EASE_OUT = 'easeOut';

/** Разбиение общей сферы: круглая на глаз и дешёвая — эффектов в кадре десятки. */
const SPHERE_SEGMENTS = 16;
const SPHERE_RINGS = 12;

/** Длительность вспышки, если запись её не назвала: короткая, но видимая. */
const DEFAULT_FLASH_MS = 300;

export interface EffectsOptions {
  /**
   * Источник визуальной поверхности (REND-9): по нему эффект садится на рельеф,
   * как инстанс. Не задан — опорной высотой служит высота уровня (REND-7).
   */
  readonly surface?: VisualSurfaceSource;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/** Живой эффект: меш из пула со своим материалом и своей записью манифеста. */
interface EffectNode {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
}

/** Оболочка: эффект, привязанный к сущности доставленного состояния. */
interface Shell extends EffectNode {
  record: VisualEffect;
  view: EntityView;
}

/** Вспышка: эффект, проигрывающий свою длительность по часам кадра. */
interface Flash extends EffectNode {
  readonly record: VisualEffect;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Сколько миллисекунд кадров прожито; `durationMs` — конец жизни. */
  ageMs: number;
  readonly durationMs: number;
}

/** Фаза жизни по кривой записи: `linear` как есть, `easeOut` — с замедлением. */
function curveOf(curve: string | undefined, t: number): number {
  if (curve === undefined || curve === CURVE_LINEAR) return t;
  if (curve === CURVE_EASE_OUT) return 1 - (1 - t) * (1 - t);
  return t;
}

/** Значение параметра по фазе: `from` → `to`, если конец назван. */
function lerpParam(from: number, to: number | undefined, phase: number): number {
  return to === undefined ? from : from + (to - from) * phase;
}

export class EffectsSubsystem implements RenderSubsystem {
  readonly name = 'effects';

  private manifest: VisualManifest;
  private readonly options: EffectsOptions;
  private readonly warn: (message: string) => void;

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  private geometry: THREE.SphereGeometry | null = null;

  private readonly shells = new Map<EntityId, Shell>();
  private flashes: Flash[] = [];
  /** Свободные меши пула: аллокация — только когда эффектов стало больше, чем было. */
  private readonly pool: EffectNode[] = [];
  /** Об неизвестном примитиве/кривой сказано один раз на имя, а не на кадр. */
  private readonly warned = new Set<string>();

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;

  constructor(manifest: VisualManifest, options: EffectsOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.warn = options.warn ?? ((message) => { console.warn(message); });
    this.group.name = 'effects';
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    this.geometry ??= new THREE.SphereGeometry(1, SPHERE_SEGMENTS, SPHERE_RINGS);
    ctx.scene.add(this.group);
  }

  /**
   * Сведение с доставленным тиком (REND-23): оболочки — с набором сущностей,
   * вспышки — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое: доигрывать вспышку через перемотку нечего (REND-2).
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) this.dropFlashes();
    this.syncShells(view);
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveEffectByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.spawnFlash(record, event.data, view);
    }
  }

  updateFrame(dt: number, alpha: number): void {
    this.poseShells(alpha);
    this.advanceFlashes(dt);
  }

  /**
   * Правленый манифест целиком (REND-17, ED-15): записи живых оболочек
   * переснимаются на месте, оболочка исчезнувшей записи убирается. Вспышки
   * переподача не трогает — они уже проигрываются по своей копии записи.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    for (const [entity, shell] of this.shells) {
      const record = shell.view.kind === null
        ? undefined
        : resolveEffectByKind(this.manifest, shell.view.kind);
      if (record === undefined) {
        this.release(shell);
        this.shells.delete(entity);
        continue;
      }
      shell.record = record;
      this.applyStatic(shell, record);
    }
  }

  /** Сколько эффектов нарисовано сейчас — вход отладки и тестов. */
  get activeCount(): number {
    return this.shells.size + this.flashes.length;
  }

  /** Сколько мешей заведено всего (пул + живые): по нему видно, что пул работает. */
  get pooledCount(): number {
    return this.pool.length + this.activeCount;
  }

  /** Оболочка сущности — вход тестов; null — эффекта на ней нет. */
  effectFor(entity: EntityId): { readonly record: VisualEffect; readonly object: THREE.Object3D } | null {
    const shell = this.shells.get(entity);
    return shell === undefined ? null : { record: shell.record, object: shell.mesh };
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView): void {
    for (const entityView of view.entities.values()) {
      const record =
        entityView.kind === null ? undefined : resolveEffectByKind(this.manifest, entityView.kind);
      if (record === undefined) continue;
      let shell = this.shells.get(entityView.id);
      if (shell === undefined) {
        const node = this.acquire(record);
        if (node === null) continue; // неизвестный примитив — пропуск с предупреждением
        shell = { ...node, record, view: entityView };
        this.shells.set(entityView.id, shell);
      }
      shell.view = entityView;
      if (shell.record !== record) {
        shell.record = record;
        this.applyStatic(shell, record);
      }
    }
    for (const [entity, shell] of this.shells) {
      const kind = view.entities.get(entity)?.kind ?? null;
      if (kind !== null && resolveEffectByKind(this.manifest, kind) !== undefined) continue;
      this.release(shell);
      this.shells.delete(entity);
    }
  }

  /**
   * Поза оболочки в кадре: горизонталь — интерполяция двух доставленных тиков
   * (REND-2), высота — опорная плюс подъём записи плюс полётная дуга по фазе
   * плоской формы (REND-12). Дугу считает та же функция, что у инстансов:
   * второй параболы в репозитории нет.
   */
  private poseShells(alpha: number): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    for (const shell of this.shells.values()) {
      const view = shell.view;
      const t = view.snap ? 1 : alpha;
      const x = view.prevX + (view.currX - view.prevX) * t;
      const y = view.prevY + (view.currY - view.prevY) * t;
      const base =
        surface !== null && !view.levelOverride
          ? surface.heightAt(x, y)
          : (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
      const arc = jumpArc(
        view.flightPhase ?? Number.NaN,
        shell.record.verticalOffset?.flightArc ?? 0,
      );
      shell.mesh.position.set(x, y, base + (shell.record.height ?? 0) + arc);
    }
  }

  // -------------------------------------------------------------- вспышки

  /**
   * Вспышка по событию (REND-23). Точка — координатные поля события; их
   * fixed-point приходится делить здесь, потому что схему события задаёт
   * контент (см. `RenderEvent.data` в `types.ts`). Нет координат — берётся
   * позиция сущности события, а нет и её — играть вспышку негде.
   */
  private spawnFlash(
    record: VisualEffect,
    data: Readonly<Record<string, number>>,
    view: TickView,
  ): void {
    let x: number;
    let y: number;
    if (data.x !== undefined && data.y !== undefined) {
      x = data.x / FIXED_ONE;
      y = data.y / FIXED_ONE;
    } else {
      const entity = data.entity ?? data.source;
      const entityView = entity === undefined ? undefined : view.entities.get(entity);
      if (entityView === undefined) return;
      x = entityView.currX;
      y = entityView.currY;
    }
    const node = this.acquire(record);
    if (node === null) return;
    const surface = this.options.surface?.current ?? null;
    const base = surface === null ? 0 : surface.heightAt(x, y);
    const flash: Flash = {
      ...node,
      record,
      x,
      y,
      z: base + (record.height ?? 0),
      ageMs: 0,
      durationMs: record.durationMs ?? DEFAULT_FLASH_MS,
    };
    flash.mesh.position.set(x, y, flash.z);
    this.flashes.push(flash);
    this.applyPhase(flash, 0);
  }

  /**
   * Фаза жизни вспышек — по часам КАДРА (SHELL-7): доставки конвертов идут
   * своим темпом, а вспышка обязана дожить свою длительность и умереть один
   * раз. Отжившие возвращаются в пул тем же проходом.
   */
  private advanceFlashes(dt: number): void {
    if (this.flashes.length === 0) return;
    let alive = 0;
    for (const flash of this.flashes) {
      flash.ageMs += dt * 1000;
      const phase = flash.durationMs <= 0 ? 1 : flash.ageMs / flash.durationMs;
      if (phase >= 1) {
        this.release(flash);
        continue;
      }
      this.applyPhase(flash, phase);
      this.flashes[alive++] = flash;
    }
    this.flashes.length = alive;
  }

  private dropFlashes(): void {
    for (const flash of this.flashes) this.release(flash);
    this.flashes.length = 0;
  }

  // ------------------------------------------------------------- примитивы

  /**
   * Меш из пула под запись: геометрия общая, материал — свой у каждого меша
   * (цвет и альфа пер-инстансны, REND-3). null — примитив записи рендеру
   * неизвестен: предупреждение один раз и пропуск, документ старше кода.
   */
  private acquire(record: VisualEffect): EffectNode | null {
    if (record.primitive !== PRIMITIVE_SPHERE) {
      this.warnOnce(
        `primitive:${record.primitive}`,
        `render: примитив эффекта "${record.primitive}" рендеру неизвестен — запись пропущена (REND-23)`,
      );
      return null;
    }
    const node = this.pool.pop() ?? this.createNode();
    node.mesh.visible = true;
    this.group.add(node.mesh);
    this.applyStatic(node, record);
    return node;
  }

  private createNode(): EffectNode {
    const geometry = this.geometry;
    if (geometry === null) throw new Error('EffectsSubsystem: init() не вызван (REND-8)');
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'effect';
    // Эффект — изображение, а не сущность: в picking он не участвует (REND-15),
    // и луч сцены его не видит даже там, где ищут не по прокси.
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
    mesh.raycast = () => {};
    return { mesh, material };
  }

  private release(node: EffectNode): void {
    node.mesh.removeFromParent();
    node.mesh.visible = false;
    this.pool.push(node);
  }

  /** Значения записи, не зависящие от фазы: цвет и стартовые радиус с альфой. */
  private applyStatic(node: EffectNode, record: VisualEffect): void {
    node.material.color.set(record.color);
    node.mesh.scale.setScalar(record.radius);
    node.material.opacity = record.alpha ?? 1;
    if (record.curve !== undefined && record.curve !== CURVE_LINEAR && record.curve !== CURVE_EASE_OUT) {
      this.warnOnce(
        `curve:${record.curve}`,
        `render: кривая эффекта "${record.curve}" рендеру неизвестна — берётся линейная (REND-23)`,
      );
    }
  }

  /** Радиус и альфа по фазе жизни: `radius → radiusTo`, `alpha → alphaTo`. */
  private applyPhase(flash: Flash, phase: number): void {
    const record = flash.record;
    const curved = curveOf(record.curve, phase);
    flash.mesh.scale.setScalar(lerpParam(record.radius, record.radiusTo, curved));
    flash.material.opacity = lerpParam(record.alpha ?? 1, record.alphaTo, curved);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}
