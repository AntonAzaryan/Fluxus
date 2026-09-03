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
 *
 * ponytail: покадровая работа самой библиотеки остаётся при ней и после того,
 * как пуловые экземпляры сняты с регистрации в батче (`acquire`/`release`):
 * `VFXBatch.update()` строит из своего множества систем два массива на батч на
 * кадр (`Array.from(...).filter(...)`), а мировые матрицы эмиттера считаются в
 * нём трижды. Работа теперь пропорциональна числу ЖИВЫХ экземпляров, а не
 * размеру пула, и этого достаточно; остальное убирает обновление или замена
 * библиотеки, а не наша обёртка.
 */
import * as THREE from 'three';
import {
  EmitSubParticleSystem,
  ParticleEmitter,
  QuarksLoader,
  type BatchedRenderer,
  type FunctionValueGenerator,
  type IEmitter,
  type ParticleSystem,
  type ValueGenerator,
  type VFXBatch,
} from 'three.quarks';
import type { ParticleEffectDocument } from '@fluxus/assets';
import type { WarnOnce } from './warnOnce.js';
export { setInstanceDensity } from './particleDensity.js';
import {
  footprintSink,
  own,
  peak,
  type FootprintResource,
  type FootprintResourceKind,
} from './footprint.js';

/**
 * Владелец ресурсов эффектов в учёте памяти (PERF-8) — разделяемый МОДУЛЬ, а не
 * подсистема: граф разворачивает пул, и живёт он ровно столько, сколько пул.
 */
const PARTICLE_EFFECTS_OWNER = 'particles.effects';

/** Заглушка разрешения обещания до того, как исполнитель отдал `resolve`. */
// eslint-disable-next-line @typescript-eslint/no-empty-function -- заглушка на один тик синхронного кода
function noop(): void {}

/** Генератор числа частиц — эмиссия во времени и счёт единовременного выброса. */
export type EmissionGenerator = ValueGenerator | FunctionValueGenerator;

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
  /**
   * Картинки документа доехали (`onLoad` загрузчика библиотеки). Разбор
   * документа синхронен, а его текстуры — нет: `ObjectLoader` грузит `images`
   * асинхронно, и заливать текстуру на GPU (`WebGLRenderer.initTexture`) до
   * этого момента нечего. Документ без картинок разрешает обещание тут же —
   * `onLoad` зовётся синхронно ещё внутри разбора.
   */
  readonly images: Promise<void>;
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
    // Экземпляров в пуле (PERF-8): живые и отдыхающие вместе. Оборот эффектов
    // растить это число MUST NOT — взятие из пула на то и заведено (PERF-9).
    //
    // Проверка стока — ЗДЕСЬ, а не внутри `peak`: аргумент вычисляется до
    // вызова, а `created` — геттер с обходом карты эффектов, то есть работа и
    // аллокация итератора на каждое взятие из пула. Без стока их быть не должно
    // вовсе (PERF-8, сценарий «Учёт без стока бесплатен»).
    if (footprintSink() !== undefined) peak('particlesPooled', this.created);
    // Регистрация систем в батче — СОБЫТИЕ взятия, а не постоянство: батч
    // перебирает свои системы каждый кадр (`VFXBatch.update` строит из них два
    // массива), и отдыхающий в пуле экземпляр платил бы за это наравне с
    // играющим — работой по размеру ПУЛА (REND-26). Батч при этом остаётся
    // прежним: конвейер у эффекта один, и `addSystem` находит его по настройкам.
    for (const played of instance.systems) this.batchRenderer.addSystem(played.system);
    parent.add(instance.object);
    instance.object.visible = true;
    // Трансформ сбрасывается ЗДЕСЬ, а не у каждого потребителя: экземпляр
    // приходит из пула с позой прошлого употребления, и сокетная оболочка
    // оставляет на нём поворот КОСТИ (REND-24). Достанься такой экземпляр
    // декорации или выстрелу, конус эмиссии оказался бы наклонён поворотом,
    // которого в новой позе нет. Позицию ставит потребитель — она есть у всех.
    instance.object.quaternion.identity();
    instance.object.scale.setScalar(1);
    restartInstance(instance);
    return instance;
  }

  /** Гасит экземпляр и возвращает его в пул своего эффекта. */
  release(instance: EffectInstance): void {
    // `stop()` гасит живые частицы и приостанавливает систему; приостановленная
    // система не симулируется, поэтому снятый со сцены экземпляр библиотека не
    // уничтожает и он доживает в пуле до следующего использования.
    for (const entry of instance.systems) {
      entry.system.stop();
      // Снятие с регистрации — пара к регистрации на взятии (см. `acquire`):
      // покадровый перебор батча идёт по ЖИВЫМ экземплярам, а не по всем
      // когда-либо созданным.
      this.batchRenderer.deleteSystem(entry.system);
    }
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
   *   (`VFXBatch`) есть, но освобождает он ОДНУ геометрию. Два материала батча
   *   — шейдерный, построенный `rebuildMaterial()`, и клон материала настроек
   *   (`VFXBatch` делает его в конструкторе) — библиотека не отдаёт вовсе, и
   *   без нашего `dispose` программа остаётся в кэше three навсегда: каждое
   *   открытие сцены редактором (ED-15) теряло бы программу и два материала.
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
      disposeBatchMaterials(batch);
    }
    this.batchRenderer.batches.length = 0;
    this.batchRenderer.systemToBatchIndex.clear();
  }

  /**
   * Текстуры образцов, разобранных пулом (ASSET-14): вход
   * `WebGLRenderer.initTexture` у прогрева. Заливка на GPU — работа первого
   * draw'а, и в кадре боя она нам не нужна.
   */
  templateTextures(): readonly THREE.Texture[] {
    const textures: THREE.Texture[] = [];
    const seen = new Set<string>();
    for (const entry of this.effects.values()) {
      entry.template?.traverse((node) => {
        collectTexture(textures, seen, textureOf(node));
      });
    }
    return textures;
  }

  /**
   * Те же текстуры, но ПОСЛЕ загрузки картинок документов (ASSET-4): разбор
   * документа синхронен, а его `images` загрузчик библиотеки тянет асинхронно.
   * Ждать этого обещания собирающий не обязан — прогрев тогда сделает меньше,
   * но сделает.
   */
  texturesReady(): Promise<readonly THREE.Texture[]> {
    const waits = [...this.effects.values()].map((entry) => entry.images);
    return Promise.all(waits).then(() => this.templateTextures());
  }

  private expand(id: string, doc: ParticleEffectDocument): EffectEntry {
    const known = this.effects.get(doc);
    if (known !== undefined) return known;
    // Обещание картинок создаётся ДО разбора: `ObjectLoader.parse` зовёт
    // `onLoad` синхронно, ещё внутри себя, когда картинок в документе нет.
    let loaded: () => void = noop;
    const images = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const entry: EffectEntry = { template: null, pool: [], created: 0, images };
    this.effects.set(doc, entry);
    try {
      entry.template = new QuarksLoader().parse(doc, () => {
        loaded();
      });
      // Ресурсы GPU, объявленные ДОКУМЕНТОМ, инстанцировал загрузчик
      // библиотеки, а владеет ими пул (см. `releaseTemplate`) — учёт PERF-8
      // получает их здесь, потому что `new THREE.*` этому владению не
      // соответствует ни одной строкой: строит их чужой код.
      ownTemplateResources(entry.template, documentResources(doc));
    } catch (e) {
      // Разбор оборвался — картинок этого документа не будет никогда, и
      // обещание разрешается здесь: иначе ожидание прогрева повисло бы на
      // документе, который и так пропущен.
      loaded();
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
      // Флипбук без атласа (REND-24): поведение `FrameOverLife` ведёт кадр
      // частицы по сетке тайлов текстуры, а сетка 1×1 — ровно один кадр, и
      // вести по ней нечего. Документ при этом легален и рисуется статичным
      // спрайтом; молчать значило бы оставить автора эффекта гадать, почему
      // анимация не идёт. Форму самих чисел атласа проверяет валидация ассета
      // (ASSET-14), а согласованность их с поведением видна только здесь —
      // документ уже развёрнут в объекты библиотеки.
      if (system.uTileCount * system.vTileCount <= 1 && leadsFrame(system)) {
        this.warnOnce(
          `flipbook:${id}`,
          `render: эффект "${id}" ведёт кадр частицы (${FRAME_BEHAVIOR_TYPE}) по атласу 1×1 — анимировать нечего (REND-24)`,
        );
      }
      // Регистрации в батче здесь НЕТ: её делает `acquire` — экземпляр
      // регистрируется на время употребления и снимается возвратом в пул.
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
interface DisposableResource extends FootprintResource {
  readonly uuid: string;
  dispose(): void;
}

/**
 * Вид ресурса графа эффекта для учёта (PERF-8). Различается по тому, в каком
 * поле системы он лежит: библиотека кладёт материал, текстуру и геометрию
 * инстансирования по своим именам, и гадать по классу здесь не о чем.
 */
function ownEffectResource(
  kind: FootprintResourceKind,
  seen: Set<string>,
  owned: ReadonlySet<string>,
  resource: DisposableResource | null | undefined,
): void {
  if (resource == null || !owned.has(resource.uuid) || seen.has(resource.uuid)) return;
  seen.add(resource.uuid);
  own(kind, PARTICLE_EFFECTS_OWNER, resource);
}

/**
 * Регистрирует в учёте (PERF-8) ресурсы разобранного графа, которые объявил
 * ДОКУМЕНТ, — ровно те, что отдаёт `releaseTemplate`: иначе живое число не
 * сошлось бы с нулём после сноса (PERF-9). Каждый uuid считается один раз —
 * материал системы и материал меша в графе законно совпадают.
 *
 * Без стока обход не идёт вовсе: он O(узлов графа), и платить за него обычной
 * игрой незачем (PERF-3).
 */
function ownTemplateResources(template: THREE.Object3D, owned: ReadonlySet<string>): void {
  if (footprintSink() === undefined) return;
  const seen = new Set<string>();
  template.traverse((node) => {
    if (node instanceof ParticleEmitter) {
      const system = node.system as ParticleSystem;
      ownEffectResource('material', seen, owned, system.material);
      ownEffectResource('texture', seen, owned, system.texture);
      ownEffectResource('geometry', seen, owned, system.instancingGeometry);
      return;
    }
    if (!(node instanceof THREE.Mesh)) return;
    const mesh = node as THREE.Mesh;
    ownEffectResource('geometry', seen, owned, mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      ownEffectResource('material', seen, owned, material);
    }
  });
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
 * Материалы батча глазами учёта и сноса (REND-31, PERF-8). Их ДВА, и оба
 * строит библиотека: шейдерный материал `rebuildMaterial()` (`batch.material`,
 * поле `Mesh`) и клон материала настроек, который `VFXBatch` делает в
 * конструкторе (`batch.settings.material`). Ни один не создан нашим
 * `new THREE.*`, поэтому в учёт они попадают регистрацией ПО ФАКТУ появления
 * батча — тем же приёмом, что ресурсы разобранного графа (`ownTemplateResources`).
 */
function batchMaterials(batch: VFXBatch): THREE.Material[] {
  const shader = batch.material;
  const list = Array.isArray(shader) ? [...shader] : [shader];
  list.push(batch.settings.material);
  return list;
}

/**
 * Регистрирует материалы свежего батча в учёте памяти (PERF-8). Зовётся один
 * раз на батч — там же, где батчам отключается луч (REND-15): новые батчи
 * появляются по мере новых конвейеров отрисовки, а не при инициализации.
 */
export function ownBatchMaterials(batch: VFXBatch): void {
  for (const material of batchMaterials(batch)) {
    own('material', PARTICLE_EFFECTS_OWNER, material);
  }
}

/**
 * Отдаёт материалы батча (REND-31): `VFXBatch.dispose()` библиотеки освобождает
 * только геометрию, и без этого прохода живое число материалов после сноса не
 * сошлось бы с нулём (PERF-9).
 */
function disposeBatchMaterials(batch: VFXBatch): void {
  for (const material of batchMaterials(batch)) material.dispose();
}

/** Текстура узла графа эффекта; null — текстуры у него нет. */
function textureOf(node: THREE.Object3D): THREE.Texture | null {
  if (node instanceof ParticleEmitter) return (node.system as ParticleSystem).texture ?? null;
  if (!(node instanceof THREE.Mesh)) return null;
  const mesh = node as THREE.Mesh;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    const map = (material as THREE.MeshBasicMaterial).map;
    if (map != null) return map;
  }
  return null;
}

/** Текстура в список — по одной на uuid: материал системы и меша законно делят её. */
function collectTexture(
  out: THREE.Texture[],
  seen: Set<string>,
  texture: THREE.Texture | null,
): void {
  if (texture === null || seen.has(texture.uuid)) return;
  seen.add(texture.uuid);
  out.push(texture);
}

/**
 * Экземпляр перестаёт ЭМИТИРОВАТЬ, а живые частицы доживают (REND-24).
 *
 * Ответ на исчезновение источника оболочки: сущность ушла из доставленного
 * состояния, состояние перестало доставляться. `stop()` библиотеки здесь не
 * годится — это `restart() + pause()`, то есть мгновенная смерть всех живых
 * частиц: след снаряда лопался бы в кадре попадания, а пыль падения — в кадре
 * приземления, при том что модель той же сущности в этот момент угасает
 * (FOW-8). Зацикливание снимается с ЭКЗЕМПЛЯРА, документ не трогается.
 */
export function endEmitInstance(instance: EffectInstance): void {
  for (const entry of instance.systems) {
    entry.system.looping = false;
    entry.system.endEmit();
  }
}

/**
 * Догорающий экземпляр отжил: эмиссия кончилась у всех его систем и живых
 * частиц не осталось.
 *
 * Признак отдельный от `instanceFinished` не по вкусу: у ЗАЦИКЛЕННОГО документа
 * `emissionState.time` оборачивается внутри длительности, и условие
 * «время эмиссии перевалило за длительность» для него не станет истиной
 * никогда — догорающий факел не вернулся бы в пул вовсе.
 */
export function instanceEmissionDone(instance: EffectInstance): boolean {
  for (const { system } of instance.systems) {
    if (system.particleNum > 0) return false;
    if (!(system as unknown as EmittingSystem).emitEnded) return false;
  }
  return true;
}

/**
 * Система частиц глазами догорания: один рантайм-флаг, который библиотека
 * объявляет приватным в типах (`ParticleSystem.emitEnded`), а `endEmit()` —
 * публичным методом. Обход инкапсулирован здесь и только здесь, ровно как у
 * шага (`SteppableSystem`): смена API при обновлении библиотеки бьётся в одной
 * точке, а не расползается по подсистеме.
 */
interface EmittingSystem {
  readonly emitEnded: boolean;
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
 *
 * ## Два клампа шага, и они нормируют разное
 *
 * Часы кадра клампят модуль `dt` в 0.25 с (`FrameTiming.dt`, REND-25): это
 * ограничение СКАЧКА часов презентации — затык главного потока не вправе
 * телепортировать анимацию. Библиотека клампит свой шаг в 0.1 с внутри
 * `ParticleSystem.update` (`ParticleSystem.ts`), и это её собственная защита от
 * длинного шага, нам не принадлежащая. Числа намеренно НЕ сводятся к одному:
 * после затыка в 250 мс вспышки уйдут на 250 мс, а частицы — на 100, и это
 * расхождение картинки, а не дефект. Там, где шаг заведомо длиннее 0.1 с —
 * догон возраста события (SHELL-4), — он режется на порции самим потребителем,
 * а не подменой чужого клампа.
 *
 * ## Отсоединённый корень
 *
 * `ParticleSystem.update` библиотеки САМО-УНИЧТОЖАЕТСЯ, если корень эмиттера —
 * не `Scene` (`currentParent.type !== 'Scene'` → `dispose()`): экземпляр
 * снимается с батча и его эмиттер отцепляется навсегда, а `restart()` его уже
 * не оживит. Отсоединённый экземпляр — обычное состояние пула, поэтому шаг
 * такого просто пропускается: гасить пул одним неудачным кадром нельзя.
 */
export function stepInstance(instance: EffectInstance, delta: number, warn: WarnOnce): void {
  // Экземпляр вне сцены (в пуле, кадр после сноса) не шагается: библиотека
  // уничтожила бы его насовсем, см. шапку.
  if (instance.object.parent === null) return;
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

/**
 * Максимальная порция догона, секунды — тот самый кламп, который библиотека
 * применяет к шагу молча (`ParticleSystem.update`). Догонять одним вызовом
 * значило бы получить 0.1 с симуляции вместо запрошенного возраста.
 */
const AGE_CHUNK_SECONDS = 0.1;

/**
 * Потолок числа порций догона. Доставка, привёзшая события давних тиков (затык
 * главного потока, скрытая вкладка), не вправе стоить кадру секунд симуляции
 * частиц: дальше потолка выстрел просто начинается тем, чем успел стать.
 */
const MAX_AGE_CHUNKS = 20;

/**
 * Догон возраста экземпляра (REND-24, SHELL-4): выстрел, приехавший событием
 * старого тика, обязан начаться уже прожившим своё расстояние — иначе пачка
 * событий нескольких тиков началась бы и кончилась одним кадром.
 *
 * Догон идёт ШАГАМИ симуляции, а не подменой времени: собственного «перемотать
 * систему на T» у библиотеки нет, а шаг она клампит (см. `stepInstance`),
 * поэтому возраст режется на порции по {@link AGE_CHUNK_SECONDS}.
 */
export function ageInstance(instance: EffectInstance, seconds: number, warn: WarnOnce): void {
  let left = Math.min(seconds, AGE_CHUNK_SECONDS * MAX_AGE_CHUNKS);
  while (left > 0) {
    const step = left > AGE_CHUNK_SECONDS ? AGE_CHUNK_SECONDS : left;
    stepInstance(instance, step, warn);
    left -= step;
  }
}

/** Тип поведения библиотеки, ведущего кадр частицы по атласу тайлов. */
const FRAME_BEHAVIOR_TYPE = 'FrameOverLife';

/** Ведёт ли система кадр частицы по атласу — потребитель тайлов (REND-24). */
function leadsFrame(system: ParticleSystem): boolean {
  return system.behaviors.some(
    (behavior: { readonly type?: unknown }) => behavior.type === FRAME_BEHAVIOR_TYPE,
  );
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
