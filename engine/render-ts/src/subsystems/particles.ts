/**
 * Подсистема частиц (REND-24): ансамбли короткоживущих спрайтов, проигрывающие
 * эффект по его описанию — огонь, дым, искры, частицы дебафа, следы.
 *
 * Отдельная подсистема за общим контрактом (REND-8), а не ветка транзиентных
 * эффектов (REND-23): у частиц свой ассет (эмиттерный документ, `assets`
 * ASSET-14) и свой конвейер отрисовки (батчи three.quarks) — общего с
 * процедурными примитивами у них только ИСТОЧНИКИ. Источники и повторены
 * один-в-один, потому что второго способа связать симуляцию с изображением
 * рендер не заводит:
 *
 * - **оболочка типа** (`particles.byKind`): живёт, пока в доставленном
 *   состоянии есть сущность такого визуального типа (след снаряда);
 * - **оболочка состояния** (`particles.byState`): живёт, пока доставленные
 *   состояния сущности несут названное состояние (частицы отравления). Биты
 *   `EntityView.states` расшифровывает список `stateComponents` сборки — ТОТ ЖЕ,
 *   что у эффектов и камеры (REND-23, `camera` CAM-6): второго словаря
 *   состояний не появляется (REND-24);
 * - **выстрел** (`particles.byEvent`): reliable-событие тика запускает one-shot,
 *   он проигрывает свою длительность по ЧАСАМ КАДРА (SHELL-7) и возвращается в
 *   пул; повторно событие не проигрывается (OBS-5);
 * - **decoration-эмиттер** (REND-18, `presentation-scene` PRES-2): статичный
 *   источник (факел, костёр) приходит набором декораций своим входом. Единый
 *   механизм отрисовки decoration на эмиттерные виды не распространяется
 *   (REND-24): их изображение — частицы, и рисует их эта подсистема, а не
 *   подсистема моделей. Декларативность набора и устойчивость ключа — REND-18
 *   без изменений.
 *
 * Симуляция частиц — чистое представление: идёт по часам кадра, пользуется
 * недетерминированным рандомом библиотеки, и расхождение картинки между
 * клиентами дефектом не считается (REND-24). Симуляции подсистема не читает
 * (её вход — `TickView`, как у всех) и в picking не участвует (REND-15):
 * попасть лучом в частицу нельзя по построению.
 *
 * Разрыв непрерывности (REND-2) гасит выстрелы и живые частицы; оболочки
 * восстанавливаются из доставленного состояния сами — собственного игрового
 * состояния у эмиттера нет.
 *
 * ## Один батч-рендерер на сцену
 *
 * `BatchedRenderer` библиотеки один на сцену (REND-24): системы с одинаковым
 * конвейером (геометрия, материал, блендинг) сливаются в один `VFXBatch`, и
 * число draw calls растёт с числом КОНВЕЙЕРОВ, а не эмиттеров. Отсюда же
 * правило разворачивания документа: экземпляры эффекта — КЛОНЫ одного образца
 * (клон делит геометрию и материал), а не повторный разбор документа, который
 * завёл бы каждому экземпляру свой материал и свой батч.
 *
 * ## Ассет, разворачивание и пул
 *
 * Документ эффекта приезжает загруженным ассетом (`RenderContext.assets`,
 * ASSET-3, ASSET-6) — тем же входом, которым подсистема моделей получает
 * модели; библиотеку частиц модуль ассетов не знает (ASSET-14). В объекты
 * three.quarks документ разворачивается ЛЕНИВО, при первом использовании
 * записи, и кэшируется по идентичности документа: переподача манифеста с той же
 * ссылкой отдаёт тот же образец и ничего не пересобирает (REND-17).
 *
 * Экземпляры эффекта живут в пуле своего эффекта: отыгравший выстрел не
 * уничтожается, а гасится и возвращается в пул — аллокаций, растущих с числом
 * событий, нет (`clone()` на выстрел был бы ровно ими). Пул не освобождается
 * НАМЕРЕННО, как и пул мешей у эффектов: он ограничен пиком одновременных
 * эмиттеров сцены, а системы частиц остаются зарегистрированными в батче и
 * ничего не рисуют, пока приостановлены.
 *
 * Недоступный или невалидный эмиттерный ассет — предупреждение один раз и
 * пропуск записи, а не отказ кадра (REND-24, ASSET-6).
 */
import * as THREE from 'three';
import { BatchedRenderer } from 'three.quarks';
import { FIXED_ONE, type EntityId } from '@game-mvp/core';
import {
  resolveParticlesByEvent,
  resolveParticlesByKind,
  resolveParticlesByState,
  resolveVisualEmitter,
  type AssetState,
  type ParticleEffectDocument,
  type VisualManifest,
} from '@game-mvp/assets';
import type { EntityView, RenderContext, RenderSubsystem, TickView } from '../types.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import type { VisualSurface } from '../visualSurface.js';
import {
  ParticleEffectPool,
  instanceFinished,
  instanceParticles,
  restartInstance,
  type EffectInstance,
} from '../particleEffects.js';

/** Пустой список имён состояний — чтобы тик без таблицы `byState` не аллоцировал. */
const NO_STATE_NAMES: readonly string[] = [];

/** Вид эмиттерного ассета в реестре загрузчиков (ASSET-14). */
const EFFECT_ASSET_KIND = 'particle-effect';

// Переиспользуемые между кадрами объекты — аллокаций на эмиттер на кадр нет.
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUATERNION = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();

/**
 * Инстансы моделей глазами подсистемы частиц — источник узлов-сокетов (REND-24).
 * Подсистема моделей удовлетворяет этому интерфейсу по форме, а импорта её сюда
 * нет: подсистемы друг о друге не знают (REND-8), и знать нужно ровно одно —
 * корень нарисованного инстанса, в котором ищется названный узел.
 */
export interface SocketSource {
  instanceFor(
    entity: EntityId,
    decoration?: boolean,
  ): { readonly model: { readonly root: THREE.Object3D } | null } | null;
}

export interface ParticlesOptions {
  /**
   * Источник визуальной поверхности (REND-9): по нему эмиттер садится на рельеф,
   * как инстанс. Не задан — опорной высотой служит высота уровня (REND-7).
   */
  readonly surface?: VisualSurfaceSource;
  /**
   * Компоненты-состояния в порядке, которым Extractor сборки выставляет биты
   * `EntityView.states` (CAM-6, SHELL-2): по нему запись `particles.byState`
   * находит свой бит. Список не задан — оболочек состояния не бывает, и запись
   * таблицы получает предупреждение один раз, а не молчание.
   */
  readonly stateComponents?: readonly string[];
  /**
   * Источник узлов-сокетов (REND-24): без него записи с сокетом играют в
   * позиции сущности и говорят об этом один раз. Опцией, а не контекстом
   * (REND-8): контракт подсистем от сокетов не меняется.
   */
  readonly sockets?: SocketSource;
  /** Куда писать предупреждения; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/** Запрошенный эмиттерный ассет; `doc` пуст, пока он едет либо недоступен. */
interface EffectAsset {
  doc: ParticleEffectDocument | null;
}

/**
 * Что подсистеме нужно от записи любого рода: ссылка на эффект, необязательный
 * сокет и множитель масштаба. Записи двух родов — эмиттер секции `particles`
 * (ASSET-14) и эмиттерный decoration-вид (ASSET-9) — подходят сюда обе, и
 * сведение оболочек оттого одно на оба набора.
 */
interface EmitterRecord {
  readonly effect: string;
  readonly socket?: string;
  readonly scale?: number;
}

/**
 * Оболочка: эмиттер, привязанный к сущности доставленного состояния либо к
 * размещённой декорации. Записи манифеста она не держит — только разобранные
 * поля: сравнивать по ссылке нечего, редактор отдаёт документ разобранным
 * заново после каждой правки (REND-17).
 */
interface Shell {
  instance: EffectInstance;
  /** Ассет эффекта, которым оболочка играет сейчас. */
  effect: string;
  socketName: string | undefined;
  scale: number;
  /** Узел-сокет: `undefined` — ещё не нашли, `null` — играем в позиции сущности. */
  socket: THREE.Object3D | null | undefined;
  view: EntityView;
  readonly decoration: boolean;
}

/** Ключ оболочки: сущность плюс имя источника (тип или состояние). */
function shellKey(entity: EntityId, source: string): string {
  return `${String(entity)}|${source}`;
}

export class ParticlesSubsystem implements RenderSubsystem {
  readonly name = 'particles';

  private manifest: VisualManifest;
  private readonly options: ParticlesOptions;
  /** Порядок состояний сборки — словарь битов `EntityView.states` (CAM-6). */
  private readonly stateComponents: readonly string[];
  private readonly warn: (message: string) => void;

  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  /** Один батч-рендерер на сцену (REND-24): батчи — его дети. */
  private readonly batchRenderer = new BatchedRenderer();
  /** Скольким батчам уже отключён луч (REND-15); новые появляются по мере эффектов. */
  private shieldedBatches = 0;

  /** Оболочки presentation-состояния по ключу «сущность + источник». */
  private readonly shells = new Map<string, Shell>();
  /**
   * Оболочки декораций — ВТОРОЙ и независимый набор (REND-18): смена продюсера
   * гасит presentation-состояние, а декорации гасить нельзя.
   */
  private readonly decorationShells = new Map<string, Shell>();
  /** Переиспользуемый набор живых ключей: сведение без аллокаций на кадр. */
  private readonly liveShells = new Set<string>();
  /** Проигрываемые выстрелы; отыгравшие возвращаются в пул тем же проходом. */
  private shots: EffectInstance[] = [];

  /** Документы эффектов по asset id (ASSET-3, ASSET-6). */
  private readonly assets = new Map<string, EffectAsset>();
  /** Разворачивание документов и пул экземпляров (`particleEffects.ts`). */
  private readonly pool: ParticleEffectPool;
  /** О недоступном ассете и битом документе сказано один раз, а не на кадр. */
  private readonly warned = new Set<string>();

  /** Последнее доставленное состояние: по нему считается поза кадра (REND-2). */
  private view: TickView | null = null;
  /** Последний набор декораций: по нему пересводятся оболочки (REND-17). */
  private decorations: ReadonlyMap<EntityId, EntityView> | null = null;

  constructor(manifest: VisualManifest, options: ParticlesOptions = {}) {
    this.manifest = manifest;
    this.options = options;
    this.stateComponents = options.stateComponents ?? [];
    this.warn = options.warn ?? ((message) => { console.warn(message); });
    this.group.name = 'particles';
    this.batchRenderer.name = 'particle-batches';
    this.pool = new ParticleEffectPool(this.batchRenderer, (key, message) => {
      this.warnOnce(key, message);
    });
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Общий с подсистемами террейна и моделей источник поверхности; init идемпотентен.
    this.options.surface?.init(ctx);
    ctx.scene.add(this.group);
    ctx.scene.add(this.batchRenderer);
  }

  /**
   * Сведение с доставленным тиком (REND-24): оболочки — с набором сущностей,
   * выстрелы — с событиями честного прохода. Разрыв непрерывности гасит
   * проигрываемое и живые частицы: доигрывать выстрел через перемотку нечего.
   */
  syncTick(view: TickView): void {
    this.view = view;
    if (view.snapAll) this.dropShots();
    this.syncShells(view);
    if (view.snapAll) this.restartShells();
    if (!view.freshEvents) return;
    for (const event of view.events) {
      const record = resolveParticlesByEvent(this.manifest, event.type);
      if (record === undefined) continue;
      this.spawnShot(record.effect, record.scale ?? 1, event.data, view);
    }
  }

  /**
   * Полный набор decoration-инстансов (REND-18). Рисуются этой подсистемой
   * ровно эмиттерные виды (REND-24): вид, чьё изображение — модель, разрешается
   * в `resolveVisualEmitter` пустым и остаётся подсистеме моделей.
   */
  syncDecorations(entities: ReadonlyMap<EntityId, EntityView>): void {
    this.decorations = entities;
    const live = this.liveShells;
    live.clear();
    for (const view of entities.values()) {
      if (view.kind === null) continue;
      const record = resolveVisualEmitter(this.manifest, view.kind);
      if (record === undefined) continue;
      this.ensureShell(this.decorationShells, view, 'deco', record, live, true);
    }
    this.sweep(this.decorationShells, live);
  }

  updateFrame(dt: number, alpha: number): void {
    this.poseShells(alpha);
    // Мировые матрицы эмиттеров — ДО симуляции: библиотека берёт позу эмиттера
    // из `matrixWorld`, а обновляет её сама только на первом кадре системы.
    this.group.updateMatrixWorld();
    this.batchRenderer.update(dt);
    this.collectShots();
    this.shieldBatches();
  }

  /**
   * Правленый манифест целиком (REND-17, ED-15): оболочки пересводятся обычным
   * проходом по последнему доставленному состоянию и последнему набору
   * декораций — правило «какие эмиттеры существуют» одно, и второй его копии
   * для переподачи не заводится. Выстрелы переподача не трогает: они уже
   * проигрываются своим экземпляром.
   */
  applyManifest(next: VisualManifest): void {
    if (next === this.manifest) return;
    this.manifest = next;
    if (this.view !== null) this.syncShells(this.view);
    if (this.decorations !== null) this.syncDecorations(this.decorations);
  }

  /** Сколько эмиттеров играет сейчас — вход отладки и тестов. */
  get activeCount(): number {
    return this.shells.size + this.decorationShells.size + this.shots.length;
  }

  /** Сколько экземпляров заведено всего (пул + живые): по нему видно, что пул работает. */
  get pooledCount(): number {
    return this.pool.created;
  }

  /** Сколько батчей отрисовки завёл рендерер — им и наблюдается батчирование (REND-24). */
  get batchCount(): number {
    return this.batchRenderer.batches.length;
  }

  /**
   * Сколько частиц живо сейчас — вход отладки и тестов. Им и наблюдается
   * гашение живых частиц разрывом непрерывности (REND-2): эмиттер-оболочка
   * остаётся, а нарисованного за ней не остаётся ничего.
   */
  get particleCount(): number {
    let total = 0;
    for (const shell of this.shells.values()) total += instanceParticles(shell.instance);
    for (const shell of this.decorationShells.values()) total += instanceParticles(shell.instance);
    for (const shot of this.shots) total += instanceParticles(shot);
    return total;
  }

  /**
   * Эмиттер сущности — вход отладки и тестов. `source` называет источник
   * (`kind:<тип>` или `state:<состояние>`); без него отдаётся первый эмиттер
   * этой сущности в порядке создания. null — эмиттера нет.
   */
  emitterFor(
    entity: EntityId,
    source?: string,
  ): { readonly effect: string; readonly object: THREE.Object3D } | null {
    if (source !== undefined) return publicShell(this.shells.get(shellKey(entity, source)));
    for (const [key, shell] of this.shells) {
      if (key.startsWith(`${String(entity)}|`)) return publicShell(shell);
    }
    return null;
  }

  /** Эмиттер размещённой декорации (REND-18); нумерация набора своя. */
  decorationEmitterFor(
    entity: EntityId,
  ): { readonly effect: string; readonly object: THREE.Object3D } | null {
    return publicShell(this.decorationShells.get(shellKey(entity, 'deco')));
  }

  // ------------------------------------------------------------- оболочки

  private syncShells(view: TickView): void {
    const live = this.liveShells;
    live.clear();
    const states = this.manifest.particles?.byState;
    // Имена таблицы состояний снимаются один раз на тик, а не на сущность.
    const stateNames = states === undefined ? NO_STATE_NAMES : Object.keys(states);
    for (const entityView of view.entities.values()) {
      if (entityView.kind !== null) {
        const record = resolveParticlesByKind(this.manifest, entityView.kind);
        if (record !== undefined) {
          this.ensureShell(this.shells, entityView, `kind:${entityView.kind}`, record, live, false);
        }
      }
      for (const name of stateNames) {
        if (!this.hasState(entityView, name)) continue;
        const record = resolveParticlesByState(this.manifest, name);
        if (record === undefined) continue;
        this.ensureShell(this.shells, entityView, `state:${name}`, record, live, false);
      }
    }
    this.sweep(this.shells, live);
  }

  /** Оболочки, не помеченные живыми в этом сведении, гаснут и уходят в пул. */
  private sweep(shells: Map<string, Shell>, live: ReadonlySet<string>): void {
    for (const [key, shell] of shells) {
      if (live.has(key)) continue;
      this.pool.release(shell.instance);
      shells.delete(key);
    }
  }

  /** Создаёт оболочку источника либо обновляет существующую; помечает её живой. */
  private ensureShell(
    shells: Map<string, Shell>,
    view: EntityView,
    source: string,
    record: EmitterRecord,
    live: Set<string>,
    decoration: boolean,
  ): void {
    const key = shellKey(view.id, source);
    let shell = shells.get(key);
    // Другой эффект в записи — другой ассет и другой экземпляр: играть его
    // прежним нечем, и это не «мигание» (REND-17).
    if (shell !== undefined && shell.effect !== record.effect) {
      this.pool.release(shell.instance);
      shells.delete(key);
      shell = undefined;
    }
    if (shell === undefined) {
      const instance = this.acquire(record.effect);
      if (instance === null) return; // ассет не доехал или невалиден — пропуск
      shell = {
        instance,
        effect: record.effect,
        socketName: record.socket,
        scale: record.scale ?? 1,
        socket: undefined,
        view,
        decoration,
      };
      shells.set(key, shell);
    }
    shell.view = view;
    shell.scale = record.scale ?? 1;
    if (shell.socketName !== record.socket) {
      shell.socketName = record.socket;
      shell.socket = undefined; // имя сокета правлено — ищем узел заново
    }
    live.add(key);
  }

  /**
   * Несёт ли доставленное состояние сущности названное состояние (REND-24).
   * Бит ищется в списке `stateComponents` сборки — том же, которым Extractor
   * их и зеркалировал (SHELL-2, CAM-6); имени вне списка соответствовать
   * нечему, и об этом говорится один раз, а не молча.
   */
  private hasState(view: EntityView, name: string): boolean {
    const bit = this.stateComponents.indexOf(name);
    if (bit < 0) {
      this.warnOnce(
        `state-bit:${name}`,
        `render: состояние "${name}" не зеркалируется Extractor'ом (stateComponents) — эмиттер не появится (REND-24)`,
      );
      return false;
    }
    return ((view.states >>> bit) & 1) === 1;
  }

  /**
   * Поза эмиттеров в кадре. Привязанный к сокету следует МИРОВОЙ позе своего
   * узла (REND-24), прочие — интерполированной позиции сущности плюс опорная
   * высота поверхности, ровно как оболочки эффектов (REND-2, REND-9).
   */
  private poseShells(alpha: number): void {
    const heightStep = this.ctx?.config.heightStep ?? 1;
    const surface = this.options.surface?.current ?? null;
    for (const shell of this.shells.values()) this.poseShell(shell, alpha, heightStep, surface);
    for (const shell of this.decorationShells.values()) {
      this.poseShell(shell, alpha, heightStep, surface);
    }
  }

  private poseShell(
    shell: Shell,
    alpha: number,
    heightStep: number,
    surface: VisualSurface | null,
  ): void {
    const object = shell.instance.object;
    // Масштаб — множитель ЗАПИСИ (ASSET-14) поверх множителя размещения
    // (REND-11, REND-18), и от сокета он не зависит: нормализация модели по
    // высоте — свойство инстанса, а размер эффекта назначает автор эффекта.
    object.scale.setScalar(shell.scale * (shell.view.scale ?? 1));
    const node = this.resolveSocket(shell);
    if (node !== null) {
      // Мировая поза узла инстанса — каждый кадр: инстанс уже поставлен
      // подсистемой моделей, а мировая матрица узла обновляется по цепочке
      // родителей, не обходом сцены.
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(SCRATCH_POSITION, SCRATCH_QUATERNION, SCRATCH_SCALE);
      object.position.copy(SCRATCH_POSITION);
      object.quaternion.copy(SCRATCH_QUATERNION);
      return;
    }
    // Горизонталь — интерполяция двух доставленных тиков (REND-2), высота —
    // опорная высота визуальной поверхности либо ступень уровня (REND-7).
    const view = shell.view;
    const t = view.snap ? 1 : alpha;
    const x = view.prevX + (view.currX - view.prevX) * t;
    const y = view.prevY + (view.currY - view.prevY) * t;
    const base =
      surface !== null && !view.levelOverride
        ? surface.heightAt(x, y)
        : (view.prevLevel + (view.currLevel - view.prevLevel) * t) * heightStep;
    object.position.set(x, y, base);
  }

  /**
   * Узел-сокет оболочки (REND-24). Ищется один раз и кэшируется на оболочке;
   * пока инстанс не построен (модель грузится, ASSET-4), поиск повторяется
   * следующим кадром — иначе эмиттер навсегда оставался бы у ног сущности из-за
   * того, что ассет ещё ехал. Инстанс есть, а узла в нём нет — предупреждение
   * один раз и позиция сущности, как у эффектов (REND-23).
   */
  private resolveSocket(shell: Shell): THREE.Object3D | null {
    if (shell.socket !== undefined) return shell.socket;
    const name = shell.socketName;
    if (name === undefined) {
      shell.socket = null;
      return null;
    }
    const sockets = this.options.sockets;
    if (sockets === undefined) {
      this.warnOnce(
        'socket-source',
        `render: запись эмиттера называет сокет "${name}", но источник инстансов подсистеме не передан — эмиттер играет в позиции сущности (REND-24)`,
      );
      shell.socket = null;
      return null;
    }
    const root = sockets.instanceFor(shell.view.id, shell.decoration)?.model?.root ?? null;
    if (root === null) return null; // инстанса ещё нет — попробуем в следующем кадре
    const node = root.getObjectByName(name) ?? null;
    if (node === null) {
      this.warnOnce(
        `socket:${name}`,
        `render: узла-сокета "${name}" в инстансе нет — эмиттер играет в позиции сущности (REND-24)`,
      );
    }
    shell.socket = node;
    return node;
  }

  /** Разрыв непрерывности гасит и живые частицы оболочек (REND-2, REND-24). */
  private restartShells(): void {
    for (const shell of this.shells.values()) restartInstance(shell.instance);
    for (const shell of this.decorationShells.values()) restartInstance(shell.instance);
  }

  // -------------------------------------------------------------- выстрелы

  /**
   * Выстрел по событию (REND-24). Точка — координатные поля события; их
   * fixed-point приходится делить здесь, потому что схему события задаёт
   * контент (см. `RenderEvent.data` в `types.ts`). Нет координат — берётся
   * позиция сущности события, а нет и её — играть выстрел негде.
   */
  private spawnShot(
    effect: string,
    scale: number,
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
    const instance = this.acquire(effect);
    if (instance === null) return;
    const surface = this.options.surface?.current ?? null;
    instance.object.position.set(x, y, surface === null ? 0 : surface.heightAt(x, y));
    instance.object.quaternion.identity();
    instance.object.scale.setScalar(scale);
    // Зацикленный документ, поставленный на событие, одноразовым не станет сам:
    // зацикливание снимается с ЭКЗЕМПЛЯРА выстрела, документ не трогается.
    for (const entry of instance.systems) entry.system.looping = false;
    this.shots.push(instance);
  }

  /**
   * Отыгравшие выстрелы — в пул. Выстрел кончился, когда все его системы
   * доэмитировали свою длительность и последняя частица умерла; длительность
   * идёт по часам КАДРА (SHELL-7), а не по тикам.
   */
  private collectShots(): void {
    if (this.shots.length === 0) return;
    let alive = 0;
    for (const shot of this.shots) {
      if (instanceFinished(shot)) {
        this.pool.release(shot);
        continue;
      }
      this.shots[alive++] = shot;
    }
    this.shots.length = alive;
  }

  private dropShots(): void {
    for (const shot of this.shots) this.pool.release(shot);
    this.shots.length = 0;
  }

  // ------------------------------------------------------- эффекты и пул

  /**
   * Экземпляр эффекта, готовый играть; null — ассет ещё не доехал, недоступен
   * или документ не разворачивается (предупреждение один раз и пропуск записи,
   * ASSET-6).
   */
  private acquire(effect: string): EffectInstance | null {
    const doc = this.document(effect);
    return doc === null ? null : this.pool.acquire(effect, doc, this.group);
  }

  /**
   * Документ эффекта по asset id (ASSET-3): запрашивается один раз на ссылку и
   * доезжает подпиской — тем же входом, которым подсистема моделей получает
   * модели (ASSET-6). null — ещё грузится либо недоступен: запись пропускается
   * молча до отказа и с предупреждением один раз после него (REND-24).
   */
  private document(id: string): ParticleEffectDocument | null {
    const known = this.assets.get(id);
    if (known !== undefined) return known.doc;
    const asset: EffectAsset = { doc: null };
    this.assets.set(id, asset);
    const ctx = this.ctx;
    if (ctx === null) throw new Error('ParticlesSubsystem: init() не вызван (REND-8)');
    const handle = ctx.assets.request<ParticleEffectDocument>(EFFECT_ASSET_KIND, id);
    ctx.assets.subscribe(handle, (state: AssetState<ParticleEffectDocument>) => {
      if (state.status === 'ready') {
        asset.doc = state.data;
      } else if (state.status === 'failed') {
        this.warnOnce(
          `effect:${id}`,
          `render: эмиттерный ассет "${id}" недоступен (${state.reason}) — запись пропущена (REND-24)`,
        );
      }
    });
    // Подписка приносит текущее состояние немедленно (ASSET-4): уже загруженный
    // документ доступен на первом же обращении, а не со следующего кадра.
    return asset.doc;
  }

  /**
   * Луч сцены частиц не видит (REND-15): частица — изображение, а не сущность.
   * Батчи заводятся по мере появления новых конвейеров отрисовки, поэтому
   * проверяется их число, а не факт «один раз при инициализации».
   */
  private shieldBatches(): void {
    const batches = this.batchRenderer.batches;
    if (batches.length === this.shieldedBatches) return;
    for (const batch of batches) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function -- пустой raycast и есть «луч меня не видит»
      batch.raycast = () => {};
    }
    this.shieldedBatches = batches.length;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }
}

/** Публичный вид оболочки — эффект и его узел; null, если оболочки нет. */
function publicShell(
  shell: Shell | undefined,
): { readonly effect: string; readonly object: THREE.Object3D } | null {
  return shell === undefined ? null : { effect: shell.effect, object: shell.instance.object };
}


