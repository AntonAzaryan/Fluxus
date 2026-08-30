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
 * Из этих трёх правил следуют две поправки к тому, что отдаёт библиотека, —
 * `relinkSubEmitters` и снятие `autoDestroy`; обе объяснены в своих местах и обе
 * сводятся к одному: жизненным циклом экземпляра владеет ПУЛ, а не документ.
 *
 * Битый документ и неразворачиваемый эффект — предупреждение один раз и пропуск
 * записи, а не отказ кадра (REND-24, ASSET-6).
 */
import * as THREE from 'three';
import {
  EmitSubParticleSystem,
  ParticleEmitter,
  QuarksLoader,
  type BatchedRenderer,
  type FunctionJSON,
  type FunctionValueGenerator,
  type GeneratorMemory,
  type IEmitter,
  type ParticleSystem,
  type ValueGenerator,
} from 'three.quarks';
import type { ParticleEffectDocument } from '@fluxus/assets';
import type { WarnOnce } from './warnOnce.js';

/** Генератор числа частиц — эмиссия во времени и счёт единовременного выброса. */
type EmissionGenerator = ValueGenerator | FunctionValueGenerator;

/**
 * Система частиц экземпляра и ДОКУМЕНТНЫЕ значения, которые с экземпляра
 * снимаются. Зацикленность запоминается потому, что экземпляр переиспользуется
 * и эмиттером-оболочкой, и выстрелом (выстрел зацикливание с себя снимает):
 * взятый из пула обязан вернуться к значениям документа, а не к тем, которыми
 * его оставило прошлое употребление. Ровно по той же причине запоминается
 * эмиссия: множитель плотности пресета качества (`render-quality` QUAL-1) —
 * значение ПОВЕРХ документа, и снимается он возвратом к документному, а не
 * делением обратно.
 */
interface EffectSystem {
  readonly system: ParticleSystem;
  readonly looping: boolean;
  /** Эмиссия во времени, как её задал документ. */
  readonly emission: EmissionGenerator;
  /** Счёт частиц каждого единовременного выброса документа, в его порядке. */
  readonly bursts: readonly EmissionGenerator[];
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
  private readonly warnOnce: WarnOnce;
  /** Развёрнутые эффекты по ИДЕНТИЧНОСТИ документа (REND-24). */
  private readonly effects = new Map<ParticleEffectDocument, EffectEntry>();

  constructor(batchRenderer: BatchedRenderer, warnOnce: WarnOnce) {
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
    const instance = entry.pool.pop() ?? this.create(id, entry, entry.template);
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

  /**
   * Снос пула (REND-31). Три шага, и порядок у них несущий:
   *
   * - экземпляры отдаются средствами библиотеки: `ParticleSystem.dispose`
   *   вынимает систему из батч-рендерера и освобождает её эмиттер. Отданы будут
   *   ровно те, что лежат в пуле, поэтому звать снос следует ПОСЛЕ возврата
   *   живых (`release`);
   * - затем образец: разобранный граф построил ПУЛ (`QuarksLoader.parse`), и
   *   владеет им он — кэш ассетов держит ДОКУМЕНТ (ASSET-14), то есть JSON, а
   *   геометрии, материалы и текстуры из него инстанцировал загрузчик. Клоны
   *   делят их с образцом (`ParticleSystem.clone` передаёт материал и геометрию
   *   ссылкой), поэтому образец отдаётся после экземпляров, а не до;
   * - и батчи, которые завёл рендерер: своего `dispose` у него нет, а у батча
   *   (`VFXBatch`) есть, и держит он геометрию.
   */
  dispose(): void {
    for (const [doc, entry] of this.effects) {
      for (const instance of entry.pool) {
        for (const played of instance.systems) played.system.dispose();
        instance.object.removeFromParent();
      }
      entry.pool.length = 0;
      if (entry.template !== null) releaseTemplate(entry.template, documentResources(doc));
      entry.template = null;
      entry.created = 0;
    }
    this.effects.clear();
    for (const batch of [...this.batchRenderer.batches]) {
      batch.removeFromParent();
      batch.dispose();
    }
    this.batchRenderer.batches.length = 0;
    this.batchRenderer.systemToBatchIndex.clear();
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

  private create(id: string, entry: EffectEntry, template: THREE.Object3D): EffectInstance {
    const object = template.clone();
    this.relinkSubEmitters(id, template, object);
    const systems: EffectSystem[] = [];
    object.traverse((child) => {
      if (!(child instanceof ParticleEmitter)) return;
      const system = child.system as ParticleSystem;
      // Жизненным циклом экземпляра владеет ПУЛ (design D6), а не документ:
      // `autoDestroy` документа заставил бы библиотеку по концу проигрывания
      // снять систему с батча и отцепить эмиттер от сцены — и экземпляр,
      // вернувшийся в пул, был бы мёртв навсегда, а не готов к следующему
      // употреблению. Значение снимается с ЭКЗЕМПЛЯРА; документ не трогается.
      system.autoDestroy = false;
      // Один батч-рендерер на сцену (REND-24): система регистрируется в нём один
      // раз на всю жизнь экземпляра — и пока экземпляр лежит в пуле тоже.
      this.batchRenderer.addSystem(system);
      systems.push({
        system,
        looping: system.looping,
        emission: system.emissionOverTime,
        bursts: system.emissionBursts.map((burst) => burst.count),
      });
    });
    entry.created += 1;
    return { object, entry, systems };
  }

  /**
   * Суб-эмиттеры клона — на СВОИ системы, а не на системы образца (REND-24).
   *
   * `EmitSubParticleSystem.clone()` библиотеки копирует ссылки как есть: и
   * подчинённый эмиттер, и систему-владельца клон наследует ОТ ОБРАЗЦА. Двух
   * последствий это стоит сразу: суб-частицы всех экземпляров эмитируются в
   * систему образца — которая в сцену не добавлена и потому не рисуется и
   * ничего не выбрасывает, — а её счётчик частиц растёт неограниченно, пока
   * играет хоть один экземпляр. Поэтому связи клона переписываются здесь.
   *
   * Переписываются они ПУБЛИЧНЫМ конструктором поведения, а не присваиванием в
   * его поля: конструктор — часть контракта библиотеки (им же пользуются её
   * собственные `fromJSON` и `clone`), а внутренности поведения — нет.
   * Соответствие узлов образца и клона снимается параллельным обходом: `Object3D.copy`
   * добавляет детей в том же порядке, в каком они у источника, и порядок обхода
   * оттого один и тот же. Не нашедшийся подчинённый узел — предупреждение один
   * раз и суб-эмиттер без цели (поведение молчит), а не ссылка на образец.
   */
  private relinkSubEmitters(id: string, template: THREE.Object3D, clone: THREE.Object3D): void {
    // Соответствие узлов строится ЛЕНИВО: у эффекта без суб-эмиттеров —
    // подавляющего большинства — обхода образца не случается вовсе.
    let twins: ReadonlyMap<unknown, THREE.Object3D> | null = null;
    const twinOf = (target: unknown): THREE.Object3D | undefined => {
      twins ??= parallelTwins(template, clone);
      return twins.get(target);
    };
    clone.traverse((node) => {
      if (!(node instanceof ParticleEmitter)) return;
      const system = node.system as ParticleSystem;
      const behaviors = system.behaviors;
      for (let i = 0; i < behaviors.length; i++) {
        const behavior = behaviors[i];
        if (!(behavior instanceof EmitSubParticleSystem)) continue;
        const target = behavior.subParticleSystem;
        const twin = target === undefined ? undefined : twinOf(target);
        if (target !== undefined && twin === undefined) {
          this.warnOnce(
            `sub-emitter:${id}`,
            `render: подчинённый эмиттер эффекта "${id}" не принадлежит его документу — суб-частицы не играют (REND-24)`,
          );
        }
        behaviors[i] = new EmitSubParticleSystem(
          system,
          behavior.useVelocityAsBasis,
          twin as IEmitter | undefined,
          behavior.mode,
          behavior.emitProbability,
        );
      }
    });
  }
}

/**
 * Соответствие «узел образца → узел клона». Строится параллельным обходом:
 * `Object3D.copy` добавляет детей в порядке источника, поэтому обход клона идёт
 * по тем же узлам и в том же порядке, что обход образца.
 */
function parallelTwins(
  template: THREE.Object3D,
  clone: THREE.Object3D,
): ReadonlyMap<unknown, THREE.Object3D> {
  const originals: THREE.Object3D[] = [];
  template.traverse((node) => originals.push(node));
  const twins = new Map<unknown, THREE.Object3D>();
  let index = 0;
  clone.traverse((node) => {
    const original = originals[index++];
    if (original !== undefined) twins.set(original, node);
  });
  return twins;
}

/**
 * UUID ресурсов, объявленных САМИМ документом (ASSET-14): геометрии, материалы
 * и текстуры, которые загрузчик графа объектов из него и построил. По ним, а не
 * по факту «попалось в графе», определяется владение (REND-31): библиотека
 * подставляет неназванной системе СВОИ умолчания — общую на весь процесс
 * геометрию квада, — и освободить их значило бы погасить все прочие эффекты.
 */
function documentResources(doc: ParticleEffectDocument): Set<string> {
  const uuids = new Set<string>();
  for (const field of ['geometries', 'materials', 'textures']) {
    const list: unknown = doc[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list as { uuid?: unknown }[]) {
      if (typeof entry.uuid === 'string') uuids.add(entry.uuid);
    }
  }
  return uuids;
}

/** Ресурс THREE глазами сноса: одно имя и одна операция. */
interface DisposableResource {
  readonly uuid: string;
  dispose(): void;
}

/**
 * Отдаёт ресурсы разобранного графа эффекта (REND-31), которые объявил документ.
 * Каждый uuid отдаётся один раз — материал системы и материал меша в графе
 * законно совпадают, а повторный `dispose` был бы вторым событием на один
 * объект. Клоны делят эти ресурсы с образцом, поэтому звать это можно только
 * после того, как экземпляры отданы.
 */
function releaseTemplate(template: THREE.Object3D, owned: Set<string>): void {
  const release = (resource: DisposableResource | null | undefined): void => {
    if (resource == null || !owned.delete(resource.uuid)) return;
    resource.dispose();
  };
  template.traverse((node) => {
    if (node instanceof ParticleEmitter) {
      const system = node.system as ParticleSystem;
      release(system.material);
      release(system.texture);
      release(system.instancingGeometry);
      return;
    }
    if (!(node instanceof THREE.Mesh)) return;
    // Сужение `instanceof` даёт параметры типа `any` — берём меш как он объявлен.
    const mesh = node as THREE.Mesh;
    release(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      release(material);
    }
  });
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

/**
 * Плотность частиц экземпляра (`render-quality` QUAL-1, REND-24): множитель
 * поверх ДОКУМЕНТНОЙ эмиссии — и потоковой, и единовременных выбросов. Единица
 * возвращает документные генераторы теми же объектами: пресет «баланс» стоит
 * ровно столько же, сколько его отсутствие.
 *
 * Правится ЭКЗЕМПЛЯР, документ не трогается: он разделяется всеми экземплярами
 * эффекта (design D6), и множитель, записанный в него, копился бы на каждом
 * взятии из пула. Информации у игрока множитель не отнимает (QUAL-2): гуще или
 * реже — вопрос картинки, а не того, что в кадре есть.
 */
export function setInstanceDensity(instance: EffectInstance, density: number): void {
  for (const entry of instance.systems) {
    entry.system.emissionOverTime = scaleEmission(entry.emission, density);
    const bursts = entry.system.emissionBursts;
    for (let i = 0; i < bursts.length; i++) {
      const source = entry.bursts[i];
      const burst = bursts[i];
      if (source === undefined || burst === undefined) continue;
      burst.count = scaleEmission(source, density);
    }
  }
}

/** Генератор документа под множителем; множитель 1 — он сам, без обёртки. */
function scaleEmission(source: EmissionGenerator, density: number): EmissionGenerator {
  if (density === 1) return source;
  return source.type === 'function'
    ? new ScaledFunction(source, density)
    : new ScaledValue(source, density);
}

/** Множитель поверх постоянного генератора документа (`type: 'value'`). */
class ScaledValue implements ValueGenerator {
  readonly type = 'value';
  private readonly source: ValueGenerator;
  private readonly factor: number;

  constructor(source: ValueGenerator, factor: number) {
    this.source = source;
    this.factor = factor;
  }

  startGen(memory: GeneratorMemory): void {
    this.source.startGen(memory);
  }

  genValue(memory: GeneratorMemory): number {
    return this.source.genValue(memory) * this.factor;
  }

  /** Сериализуется ДОКУМЕНТНОЕ значение: множитель — настройка, а не данные эффекта. */
  toJSON(): FunctionJSON {
    return this.source.toJSON();
  }

  clone(): ValueGenerator {
    return new ScaledValue(this.source.clone(), this.factor);
  }
}

/** То же для генератора, зависящего от фазы жизни системы (`type: 'function'`). */
class ScaledFunction implements FunctionValueGenerator {
  readonly type = 'function';
  private readonly source: FunctionValueGenerator;
  private readonly factor: number;

  constructor(source: FunctionValueGenerator, factor: number) {
    this.source = source;
    this.factor = factor;
  }

  startGen(memory: GeneratorMemory): void {
    this.source.startGen(memory);
  }

  genValue(memory: GeneratorMemory, t: number): number {
    return this.source.genValue(memory, t) * this.factor;
  }

  toJSON(): FunctionJSON {
    return this.source.toJSON();
  }

  clone(): FunctionValueGenerator {
    return new ScaledFunction(this.source.clone(), this.factor);
  }
}

/**
 * Система частиц глазами шага: один рантайм-метод, которого нет в типах
 * библиотеки (см. `stepInstance`).
 */
interface SteppableSystem {
  update(delta: number): void;
}

/**
 * Полный тик систем экземпляра (REND-24) — единственная точка, где рендер зовёт
 * шаг симуляции частиц библиотеки.
 *
 * Она существует потому, что персональный темп есть у СУЩНОСТИ, а не у сцены
 * (REND-38): общий `BatchedRenderer.update(delta)` шагает все системы одним
 * числом, и оболочке замедленного героя не досталось бы своего. Разложить его
 * на «шаг каждой системы + проход по батчам» можно — это ровно то, что он
 * внутри и делает, — но `ParticleSystem.update` в ТИПАХ библиотеки приватен
 * (в рантайме это обычный метод, а `IParticleSystem` его не объявляет;
 * `emit(delta, …)` не замена — это внутренний шаг эмиссии, а не тик системы).
 *
 * Обход инкапсулирован здесь и только здесь: структурный тип поверх рантайм-
 * метода плюс проверка `typeof`. Смена API при обновлении библиотеки бьётся в
 * этой точке — предупреждением один раз и остановкой частиц, а не молчаливой
 * заморозкой картинки; юнит-тест шага (`particles.test.ts`) падает там же.
 *
 * Цикл здесь ИНДЕКСНЫЙ — по дисциплине аллокаций кадра (REND-26); почему
 * именно так, сказано над самим циклом.
 */
export function stepInstance(instance: EffectInstance, delta: number, warn: WarnOnce): void {
  const systems = instance.systems;
  /* eslint-disable-next-line @typescript-eslint/prefer-for-of --
   * Индексный цикл намеренно: шаг зовётся на КАЖДЫЙ эмиттер каждого кадра, а
   * `for-of` идёт через протокол итератора — объект на вызов, то есть
   * аллокация, растущая с числом инстансов (REND-26). Общий
   * `BatchedRenderer.update`, который здесь заменён, не платил и этого. */
  for (let i = 0; i < systems.length; i++) {
    const system = systems[i]!.system as unknown as SteppableSystem;
    if (typeof system.update !== 'function') {
      warn(
        'particle-step',
        'render: у системы частиц библиотеки нет метода update(delta) — шаг эмиттеров невозможен, частицы не играют (REND-24)',
      );
      return;
    }
    system.update(delta);
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
