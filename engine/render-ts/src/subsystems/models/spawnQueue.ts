/**
 * Очередь отложенного МОНТИРОВАНИЯ инстанса (REND-44, design D10 изменения
 * `frame-budget`).
 *
 * ## Что здесь режется
 *
 * Волна спавна — это пачка новых сущностей в ОДНОЙ доставке, и дорога в ней не
 * запись пула, а то, что монтируется под запись: разделяемая часть модели,
 * слот батча либо пер-инстансное поддерево со скелетом и материалами, носители
 * света и контактного пятна. Сама запись стоит объекта, и её сведение остаётся
 * синхронным: доставка применяется целиком (REND-3), и «половина доставки» —
 * не отложенная работа, а дефект.
 *
 * Наблюдаемое отличие ровно одно и ровно то, которое REND-44 разрешает:
 * инстанс появляется на кадр-другой позже. Ни одна запись при этом не теряется
 * — очередь либо смонтирует её, либо отменит вместе с самой записью.
 *
 * ## Очередь наполняется только под ОГРАНИЧЕННЫМ бюджетом
 *
 * Неограниченный бюджет по REND-44 означает «резать нечего», и это умолчание:
 * сцена, которой потолок не назвали, обязана вести себя ровно как сцена без
 * механизма вовсе. Поэтому очередь молчит, пока ей не показали ОГРАНИЧЕННЫЙ
 * бюджет: до этого монтирование синхронное, байт-в-байт прежнее.
 *
 * Из этого правила само собой следуют три вещи, которые иначе пришлось бы
 * выговаривать по отдельности. Подсистема, которую крутят без сцены (вьюпорт
 * редактора, стенды, тесты), фазы не видит и не откладывает — иначе отложенное
 * в такой сборке не доехало бы никогда. Документный продюсер работает с
 * неограниченным бюджетом (REND-11, ED-15) — и мазок автора виден в том же
 * кадре. Замер счётных величин идёт без бюджета (PERF-3, PERF-8) — и число
 * отложений на нём нулевое ПО ПОСТРОЕНИЮ, а не по совпадению.
 *
 * ## Порядок — по расстоянию до камеры
 *
 * Пока волна доезжает, важно, ЧТО именно доехало: ближний к камере инстанс
 * виден игроку, дальний — нет. Поэтому порция берётся с ближнего конца, а не с
 * головы очереди. Расстояние считается по ДОСТАВЛЕННОЙ позиции записи: позы
 * кадра у неё ещё нет (её ставит `updateFrame`, а фаза идёт до него).
 * Камеры нет — порядок остаётся порядком доставки, и это не хуже: без камеры
 * нет и «ближе».
 */
import * as THREE from 'three';
import type { FrameBudget } from '../../types.js';
import type { InstanceRecord } from './instanceRecord.js';

/** Позиция камеры прохода — переиспользуемая: аллокаций у фазы нет (REND-26). */
const CAMERA_POSITION = new THREE.Vector3();

/** Монтирование одной записи — обратный вызов владельца пула. */
export type MountInstance = (record: InstanceRecord) => void;

export class SpawnQueue {
  /**
   * Записи, ждущие монтирования. Отменённые из массива НЕ вынимаются, а
   * помечаются на самой записи (`pendingMount`): отмена приходит сведением
   * пула, то есть пачкой, и вырезание из середины стоило бы сдвигом на каждую.
   * Просеиваются они на ближайшем же проходе.
   */
  private readonly pending: InstanceRecord[] = [];
  /**
   * Последний показанный фазой бюджет был ОГРАНИЧЕН (REND-44). Пока это не так,
   * откладывать нечего и некому — см. шапку модуля.
   */
  private limited = false;

  /** Ждут монтирования (с учётом отменённых пометок) — проба для тестов. */
  get size(): number {
    let live = 0;
    for (const record of this.pending) if (record.pendingMount) live++;
    return live;
  }

  /**
   * Отложить монтирование записи. `false` — фазы нет, и владелец обязан
   * смонтировать её сам, прямо сейчас.
   */
  defer(record: InstanceRecord): boolean {
    if (!this.limited) return false;
    record.pendingMount = true;
    this.pending.push(record);
    return true;
  }

  /**
   * Запись уходит (исчезла из доставки, сменила вид, пересобирается): её
   * пометка снимается, и очередь смонтирует пустое место, а не мёртвую запись.
   * Для записи, в очереди не стоявшей, — no-op.
   */
  cancel(record: InstanceRecord): void {
    record.pendingMount = false;
  }

  /**
   * Порция монтирований под бюджетом прохода (REND-44). Первая порция идёт при
   * любом потолке — гарантию даёт сам бюджет (`hasTime`), — а не уместившийся
   * остаток помечается отложенным и доедет следующими кадрами.
   */
  drain(budget: FrameBudget, mount: MountInstance, camera: THREE.Camera | undefined): void {
    this.limited = !budget.unlimited;
    if (this.pending.length === 0) return;
    this.sift();
    if (this.pending.length === 0) return;
    if (camera !== undefined) this.orderByCamera(camera);
    let mounted = 0;
    while (mounted < this.pending.length && budget.hasTime()) {
      // Монтирование — ЦЕЛАЯ порция (REND-44): наполовину смонтированного
      // инстанса в кадре не бывает, и бюджет спрашивается между записями.
      mount(this.pending[mounted]!);
      this.pending[mounted]!.pendingMount = false;
      mounted++;
    }
    if (mounted === this.pending.length) {
      this.pending.length = 0;
      return;
    }
    this.pending.splice(0, mounted);
    // Отложение — счётная величина стока (PERF-3), и зовёт её тот, кто
    // откладывает: одна пометка на проход, а не на оставшуюся запись, —
    // отложен ОСТАТОК, и считать его записями значило бы мерить не то.
    budget.defer();
  }

  /**
   * Доделать всё без нарезки — синхронная точка (REND-44): разрыв
   * непрерывности, снос сцены, переподача манифеста, смена поколения ассетов.
   */
  flush(mount: MountInstance): void {
    if (this.pending.length === 0) return;
    for (const record of this.pending) {
      if (!record.pendingMount) continue;
      record.pendingMount = false;
      mount(record);
    }
    this.pending.length = 0;
  }

  /** Снос подсистемы (REND-31): монтировать больше не для чего и не во что. */
  clear(): void {
    for (const record of this.pending) record.pendingMount = false;
    this.pending.length = 0;
  }

  /** Отменённые пометки — вон из массива одним проходом. */
  private sift(): void {
    let write = 0;
    for (const record of this.pending) {
      if (record.pendingMount) this.pending[write++] = record;
    }
    this.pending.length = write;
  }

  /**
   * Ближние к камере — в начало (REND-44): порция берётся с того конца, где
   * задержку видно. Сортировка идёт НА МЕСТЕ и один раз на проход, а не на
   * запись: расстояние сравнивается квадратом — корня порядок не меняет.
   */
  private orderByCamera(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    CAMERA_POSITION.setFromMatrixPosition(camera.matrixWorld);
    const cx = CAMERA_POSITION.x;
    const cy = CAMERA_POSITION.y;
    this.pending.sort((a, b) => flatDistance(a, cx, cy) - flatDistance(b, cx, cy));
  }
}

/**
 * Квадрат расстояния от камеры до ДОСТАВЛЕННОЙ позиции записи. Позы кадра у
 * неё ещё нет — фаза идёт до `updateFrame`, — а высота в сравнении не
 * участвует: камера смотрит на арену сверху, и «ближе» здесь про план, а не
 * про ступень.
 */
function flatDistance(record: InstanceRecord, cx: number, cy: number): number {
  const view = record.view;
  const dx = view.currX - cx;
  const dy = view.currY - cy;
  return dx * dx + dy * dy;
}
