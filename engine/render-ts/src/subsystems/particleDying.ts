/**
 * Догорающие экземпляры погасших оболочек (REND-24) — вынесенная из подсистемы
 * частиц механика «эмиссия прекращается, живые частицы доживают».
 *
 * Исчезновение источника оболочки — сущность ушла из доставленного состояния,
 * состояние перестало доставляться, запись исчезла из правленого манифеста —
 * ЭМИССИЮ прекращает, а выпущенные частицы обязаны дожить своё время: след
 * снаряда не лопается в кадре попадания, а пыль падения — в кадре приземления,
 * при том что модель той же сущности в этот момент угасает `fadeSeconds`
 * (FOW-8). Возвращать экземпляр в пул сразу (`stop()` библиотеки — это
 * `restart() + pause()`) значило бы гасить всё нарисованное за оболочкой в тот
 * же кадр.
 *
 * Часы у догорающих ОБЩИЕ: сущности за ними больше нет, и персональной шкалы
 * времени (REND-38) взять неоткуда. Разрыв непрерывности (REND-2) гасит их
 * немедленно — доигрывать через перемотку нечего.
 */
import type { RenderCostCounters } from '../cost.js';
import {
  endEmitInstance,
  instanceEmissionDone,
  instanceParticles,
  stepInstance,
  type EffectInstance,
} from '../particleEffects.js';
import type { WarnOnce } from '../warnOnce.js';

export class DyingInstances {
  private list: EffectInstance[] = [];

  /** Сколько экземпляров догорает сейчас — вход отладки и тестов. */
  get size(): number {
    return this.list.length;
  }

  /** Сколько частиц живо у догорающих: они НАРИСОВАНЫ и считаются наравне. */
  get particles(): number {
    let total = 0;
    for (const instance of this.list) total += instanceParticles(instance);
    return total;
  }

  /** Оболочка погасла: эмиссия прекращается, живые частицы остаются. */
  retire(instance: EffectInstance): void {
    endEmitInstance(instance);
    this.list.push(instance);
  }

  /** Шаг общими часами — тот же, которым идут выстрелы по событию. */
  step(delta: number, warnOnce: WarnOnce): void {
    for (const instance of this.list) stepInstance(instance, delta, warnOnce);
  }

  /**
   * Догоревшие — в пул; проход тот же, что у выстрелов, и считается так же
   * (PERF-2): догорающий шагался в этом кадре и просмотрен в этом проходе.
   */
  collect(release: (instance: EffectInstance) => void, cost: RenderCostCounters | undefined): void {
    if (this.list.length === 0) return;
    if (cost !== undefined) cost.particlesShotsStepped += this.list.length;
    let alive = 0;
    for (const instance of this.list) {
      if (cost !== undefined) cost.particlesSystemsStepped += instance.systems.length;
      if (instanceEmissionDone(instance)) {
        release(instance);
        continue;
      }
      this.list[alive++] = instance;
    }
    this.list.length = alive;
  }

  /**
   * Все — в пул немедленно. Так гасит их разрыв непрерывности (REND-2), и так
   * же кончается снос подсистемы (REND-31).
   */
  dropAll(release: (instance: EffectInstance) => void): void {
    for (const instance of this.list) release(instance);
    this.list.length = 0;
  }
}
