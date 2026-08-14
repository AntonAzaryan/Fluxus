/**
 * Разворачивание эмиттерных ассетов и пул экземпляров эффекта — внутренность
 * подсистемы частиц (REND-24), вынесенная отдельно от её источников: сведение
 * эмиттеров с доставленным состоянием и жизненный цикл объектов библиотеки —
 * разные вопросы, и мешать их в одном модуле незачем.
 *
 * Три правила, ради которых модуль существует:
 *
 * - **разбор ленивый и ровно один на документ** (REND-24, design D3): документ
 *   приезжает загруженным ассетом (`assets` ASSET-14), в объекты three.quarks
 *   его разворачивает первый употребивший, а кэш ключуется ИДЕНТИЧНОСТЬЮ
 *   документа — переподача манифеста с той же ссылкой ничего не пересобирает
 *   (REND-17);
 * - **экземпляры — клоны образца, а не повторный разбор** (design D6): клон
 *   делит с образцом геометрию и материал, и потому сотня факелов одного
 *   эффекта сливается в ОДИН батч; повторный разбор завёл бы каждому свой
 *   материал и свой draw call. Образец в сцену не попадает и не проигрывается;
 * - **отыгравший возвращается в пул**: `clone()` на каждое событие аллоцировал
 *   бы пропорционально событиям. Пул не освобождается намеренно — он ограничен
 *   пиком одновременных эмиттеров сцены, а приостановленная система частиц не
 *   симулируется и не рисует ничего.
 *
 * Битый документ и неразворачиваемый эффект — предупреждение один раз и пропуск
 * записи, а не отказ кадра (REND-24, ASSET-6).
 */
import * as THREE from 'three';
import {
  ParticleEmitter,
  QuarksLoader,
  type BatchedRenderer,
  type ParticleSystem,
} from 'three.quarks';
import type { ParticleEffectDocument } from '@game-mvp/assets';

/**
 * Система частиц экземпляра и её ДОКУМЕНТНАЯ зацикленность. Зацикленность
 * запоминается потому, что экземпляр переиспользуется и эмиттером-оболочкой, и
 * выстрелом (выстрел зацикливание с себя снимает): взятый из пула обязан
 * вернуться к значениям документа, а не к тем, которыми его оставило прошлое
 * употребление.
 */
export interface EffectSystem {
  readonly system: ParticleSystem;
  readonly looping: boolean;
}

/** Развёрнутый эффект: образец графа объектов и пул его экземпляров. */
export interface EffectEntry {
  template: THREE.Object3D | null;
  readonly pool: EffectInstance[];
  /** Сколько экземпляров заведено всего (пул + живые) — по нему видно пул. */
  created: number;
}

/** Экземпляр эффекта: узел сцены плюс системы частиц, которыми он играет. */
export interface EffectInstance {
  readonly object: THREE.Object3D;
  readonly entry: EffectEntry;
  readonly systems: readonly EffectSystem[];
}

export class ParticleEffectPool {
  private readonly batchRenderer: BatchedRenderer;
  private readonly warnOnce: (key: string, message: string) => void;
  /** Развёрнутые эффекты по ИДЕНТИЧНОСТИ документа (REND-24). */
  private readonly effects = new Map<ParticleEffectDocument, EffectEntry>();

  constructor(batchRenderer: BatchedRenderer, warnOnce: (key: string, message: string) => void) {
    this.batchRenderer = batchRenderer;
    this.warnOnce = warnOnce;
  }

  /** Сколько экземпляров заведено всего (пул + живые): по нему видно, что пул работает. */
  get created(): number {
    let total = 0;
    for (const entry of this.effects.values()) total += entry.created;
    return total;
  }

  /**
   * Экземпляр эффекта, готовый играть: из пула, а нет свободного — клоном
   * образца. null — документ не разворачивается (сказано один раз).
   */
  acquire(id: string, doc: ParticleEffectDocument, parent: THREE.Object3D): EffectInstance | null {
    const entry = this.expand(id, doc);
    if (entry.template === null) return null;
    const instance = entry.pool.pop() ?? this.create(entry, entry.template);
    parent.add(instance.object);
    instance.object.visible = true;
    restartInstance(instance);
    return instance;
  }

  /** Гасит экземпляр и возвращает его в пул своего эффекта. */
  release(instance: EffectInstance): void {
    // `stop()` гасит живые частицы и приостанавливает систему; приостановленная
    // система не симулируется, поэтому снятый со сцены экземпляр библиотека не
    // уничтожает и он доживает в пуле до следующего использования.
    for (const entry of instance.systems) entry.system.stop();
    instance.object.removeFromParent();
    instance.object.visible = false;
    instance.entry.pool.push(instance);
  }

  private expand(id: string, doc: ParticleEffectDocument): EffectEntry {
    const known = this.effects.get(doc);
    if (known !== undefined) return known;
    const entry: EffectEntry = { template: null, pool: [], created: 0 };
    this.effects.set(doc, entry);
    try {
      entry.template = new QuarksLoader().parse(doc);
    } catch (e) {
      this.warnOnce(
        `expand:${id}`,
        `render: эмиттерный ассет "${id}" не разворачивается (${e instanceof Error ? e.message : String(e)}) — запись пропущена (REND-24)`,
      );
    }
    return entry;
  }

  private create(entry: EffectEntry, template: THREE.Object3D): EffectInstance {
    const object = template.clone();
    const systems: EffectSystem[] = [];
    object.traverse((child) => {
      if (!(child instanceof ParticleEmitter)) return;
      const system = child.system as ParticleSystem;
      // Один батч-рендерер на сцену (REND-24): система регистрируется в нём один
      // раз на всю жизнь экземпляра — и пока экземпляр лежит в пуле тоже.
      this.batchRenderer.addSystem(system);
      systems.push({ system, looping: system.looping });
    });
    entry.created += 1;
    return { object, entry, systems };
  }
}

/**
 * Экземпляр с начала: живые частицы сбрасываются, симуляция снимается с паузы,
 * зацикленность возвращается к документной (её мог снять прошлый выстрел).
 */
export function restartInstance(instance: EffectInstance): void {
  for (const entry of instance.systems) {
    entry.system.looping = entry.looping;
    entry.system.restart();
  }
}

/** Сколько частиц живо у экземпляра сейчас. */
export function instanceParticles(instance: EffectInstance): number {
  let total = 0;
  for (const { system } of instance.systems) total += system.particleNum;
  return total;
}

/**
 * Экземпляр отыграл: все его системы доэмитировали свою длительность и потеряли
 * последнюю частицу. Подсистемы-эмиттеры, которыми правит родитель
 * (`onlyUsedByOther`), собственной длительности не имеют, и судить о них можно
 * только по частицам.
 */
export function instanceFinished(instance: EffectInstance): boolean {
  for (const { system } of instance.systems) {
    if (system.particleNum > 0) return false;
    if (!system.onlyUsedByOther && system.emissionState.time <= system.duration) return false;
  }
  return true;
}
