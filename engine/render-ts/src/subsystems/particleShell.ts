/**
 * Оболочка эмиттера (REND-24) — запись «эмиттер, привязанный к сущности
 * доставленного состояния либо к размещённой декорации», её публичный вид, её
 * поза и её шаг.
 *
 * Вынесена из подсистемы частиц по той же причине, по какой из неё вынесены пул
 * экземпляров (`particleEffects.ts`) и привязка к узлу-сокету
 * (`particleSockets.ts`): «что такое оболочка» и «какие оболочки существуют» —
 * разные вопросы. Первый — данные и два коротких перевода между ними, второй —
 * сведение с доставленным состоянием, и оно остаётся общим набором
 * (`shellSupport.ts`, `ShellSet`), разделяемым с подсистемой эффектов.
 *
 * Сверх общей оболочки эмиттер несёт одно: КЭШ найденного узла-сокета и корня,
 * из которого узел взят. Имя сокета лежит рядом с кэшем, а не читается из
 * записи каждый кадр, ровно затем, чтобы смену имени было с чем сравнить:
 * редактор отдаёт документ разобранным заново после каждой правки (REND-17), и
 * сравнение по ссылке на запись здесь ничего не значит.
 */
import * as THREE from 'three';
import type { RenderCostCounters } from '../cost.js';
import { stepInstance, type EffectInstance } from '../particleEffects.js';
import {
  dropSocketCache,
  resolveSocketPose,
  type SocketPose,
  type SocketSource,
} from '../particleSockets.js';
import type { VisualSurface } from '../visualSurface.js';
import type { WarnOnce } from '../warnOnce.js';
import { ShellSet, poseShell, type Shell, type ShellPose } from './shellSupport.js';

/**
 * Что подсистеме нужно от записи любого рода: ссылка на эффект, необязательный
 * сокет и множитель масштаба. Записи двух родов — эмиттер секции `particles`
 * (`assets` ASSET-14) и эмиттерный decoration-вид (ASSET-9) — подходят сюда
 * обе, и сведение оболочек оттого одно на оба набора.
 */
export interface EmitterRecord {
  readonly effect: string;
  readonly socket?: string;
  readonly scale?: number;
}

/** Оболочка эмиттера: общая оболочка плюс кэш найденного узла-сокета. */
export interface EmitterShell extends Shell<EmitterRecord, EffectInstance> {
  /** Имя узла из записи манифеста; по нему и видно, что имя правлено (REND-17). */
  socketName: string | undefined;
  /** Кэш найденного узла-сокета и корня, из которого он взят (`particleSockets.ts`). */
  socket: THREE.Object3D | null;
  socketRoot: THREE.Object3D | null;
}

/**
 * Три ответа, которыми подсистема частиц отличается от других владельцев набора
 * оболочек (`shellSupport.ts`): чем оболочка играет, куда она уходит погаснув и
 * где брать узлы-сокеты. Собраны здесь, а не расписаны по колбэкам подсистемы:
 * наборов ДВА — сущности доставленного состояния и декорации (REND-18), — и
 * отличаются они между собой ровно одним флагом.
 */
export interface EmitterShellHooks {
  /** Экземпляр эффекта, готовый играть; null — ассет не доехал или невалиден. */
  acquire(effect: string): EffectInstance | null;
  /**
   * Оболочка погасла: эмиссия прекращается, живые частицы доживают (REND-24).
   * В пул экземпляр возвращает подсистема — сама, концом догорания.
   */
  retire(instance: EffectInstance): void;
  /** Источник узлов-сокетов; `undefined` — записи с сокетом играют в позиции сущности. */
  sockets(): SocketSource | undefined;
  warnOnce: WarnOnce;
}

/**
 * Набор оболочек одного рода. Родов два — сущности доставленного состояния и
 * декорации (REND-18), — и отличаются они ровно тем, чьими часами идут их
 * эмиттеры (`stepShells`): у декорации сущности симуляции за спиной нет, и
 * персональной шкалы времени у неё не бывает.
 */
export function createEmitterShellSet(
  decoration: boolean,
  hooks: EmitterShellHooks,
): ShellSet<EmitterRecord, EffectInstance, EmitterShell> {
  return new ShellSet<EmitterRecord, EffectInstance, EmitterShell>({
    acquire: (key, source, view, record) => {
      const instance = hooks.acquire(record.effect);
      if (instance === null) return null; // ассет не доехал или невалиден — пропуск
      return {
        key,
        source,
        decoration,
        instance,
        record,
        view,
        socketName: record.socket,
        socket: null,
        socketRoot: null,
      };
    },
    release: (shell) => {
      hooks.retire(shell.instance);
    },
    rebind: (shell, record) => {
      // Другой эффект в записи — другой ассет и другой экземпляр: играть его
      // прежним нечем, и это не «мигание» (REND-17).
      if (shell.record.effect !== record.effect) return false;
      if (shell.socketName !== record.socket) {
        shell.socketName = record.socket;
        dropSocketCache(shell); // имя сокета правлено — ищем узел заново
      }
      return true;
    },
    pose: (shell, alpha, heightStep, surface, pose) => {
      poseEmitterShell(shell, alpha, heightStep, surface, hooks.sockets(), hooks.warnOnce, pose);
    },
  });
}

/** Публичный вид оболочки — эффект и его узел; null, если оболочки нет. */
export function publicShell(
  shell: EmitterShell | undefined,
): { readonly effect: string; readonly object: THREE.Object3D } | null {
  return shell === undefined
    ? null
    : { effect: shell.record.effect, object: shell.instance.object };
}

/** Переиспользуемая поза сокета — аллокаций на эмиттер на кадр нет. */
const SCRATCH_SOCKET: SocketPose = {
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
};

/**
 * Поза эмиттера-оболочки в кадре. Привязанный к сокету следует МИРОВОЙ позе
 * своего узла (REND-24), прочие — интерполированной позиции сущности плюс
 * опорная высота поверхности, ровно как оболочки эффектов (REND-2, REND-9).
 * `warnOnce` приходит готовой функцией, а не обёрткой: обёртка была бы
 * замыканием на каждую оболочку каждого кадра — в установившемся кадре путь
 * не аллоцирует пропорционально числу эмиттеров.
 */
function poseEmitterShell(
  shell: EmitterShell,
  alpha: number,
  heightStep: number,
  surface: VisualSurface | null,
  sockets: SocketSource | undefined,
  warnOnce: WarnOnce,
  pose: ShellPose,
): void {
  const object = shell.instance.object;
  // Масштаб — множитель ЗАПИСИ (ASSET-14) поверх множителя размещения
  // (REND-11, REND-18), и от сокета он не зависит: нормализация модели по
  // высоте — свойство инстанса, а размер эффекта назначает автор эффекта.
  object.scale.setScalar((shell.record.scale ?? 1) * (shell.view.scale ?? 1));
  if (resolveSocketPose(shell, shell.view.id, sockets, warnOnce, SCRATCH_SOCKET)) {
    object.position.copy(SCRATCH_SOCKET.position);
    object.quaternion.copy(SCRATCH_SOCKET.quaternion);
    return;
  }
  // Горизонталь — интерполяция двух доставленных тиков (REND-2), высота —
  // опорная высота визуальной поверхности либо ступень уровня (REND-7): то же
  // общее правило оболочек, что у эффектов (`shellSupport.ts`).
  poseShell(shell.view, alpha, heightStep, surface, pose);
  object.position.set(pose.x, pose.y, pose.base);
}

/**
 * Шаг симуляции оболочек в кадре (REND-24, REND-38).
 *
 * Часы у оболочек РАЗНЫЕ, и решает это сама оболочка: за оболочкой сущности
 * стоит доставленное состояние, и её эмиттеры идут кадровыми часами,
 * умноженными на персональную шкалу времени сущности (`EntityView.timeScale`,
 * `time-system` TIME-2) — замедленный герой обязан и дымить замедленно.
 * Decoration размещена СЦЕНОЙ (REND-18), сущности симуляции за ней нет, шкалы у
 * неё не бывает, и факел внутри зоны замедления играет обычным темпом.
 *
 * Значение берётся как есть: оно приходит сведённым и клампленным
 * (`TimeScaleSystem`, TIME-7), и переклампливать его рендеру нечем и незачем.
 *
 * Здесь же снимается счёт шагнутых систем (PERF-3): раньше он снимался в позе —
 * шага как отдельной работы просто не было, — а теперь считается там, где
 * работа и делается. Число то же: те же оболочки, тот же кадр.
 */
export function stepShells(
  shells: Iterable<EmitterShell>,
  delta: number,
  warnOnce: WarnOnce,
  cost: RenderCostCounters | undefined,
): void {
  for (const shell of shells) {
    if (cost !== undefined) cost.particlesSystemsStepped += shell.instance.systems.length;
    stepInstance(shell.instance, shell.decoration ? delta : delta * shell.view.timeScale, warnOnce);
  }
}
