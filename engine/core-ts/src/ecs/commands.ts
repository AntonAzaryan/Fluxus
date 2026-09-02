/**
 * Command Buffer (CMD-1..5): единственный канал мутаций для систем (DET-7).
 * Команды копятся в плоском журнале в порядке создания и применяются в том же
 * порядке на flush (CMD-3) — до flush world не меняется, поэтому Query внутри
 * системы видит состояние на её начало (CMD-5, QUERY-3). flush per-system
 * вызывает планировщик (CMD-2), сам буфер за это не отвечает.
 *
 * Журнал — параллельные типизированные массивы, а не список объектов: запись
 * поля есть самая частая команда тика (пять на агента у платформы NPC, две у
 * физики), и объект на каждую был бы аллокацией, пропорциональной числу
 * сущностей, — ровно тем, что аллокационная дисциплина ядра запрещает в
 * горячем пути. Массивы растут удвоением и переиспользуются между тиками
 * (`reset`), поэтому установившийся матч под команды не аллоцирует вовсе.
 * Структурные команды (`spawn`/`addComponent`/`removeComponent`) остаются
 * объектами в боковом списке, на который журнал ссылается индексом: их
 * единицы, а полей у них разнородно много.
 *
 * Адрес записи поля бывает двух видов, и оба — ОДИН канал (CMD-1): строковый,
 * которым живут JSON-системы, и handle'ом (`data-driven-systems` SYS-10),
 * которым пользуются нативные системы горячих циклов. Порядок применения у них
 * общий (CMD-3), точечное чтение видит обе (CMD-5), в трейсе они неразличимы —
 * имена компонента и поля handle-команда берёт из плоской таблицы полей мира в
 * момент записи трейса (DIAG-2, DIAG-5), а не хранит.
 *
 * flush идёт двумя проходами — сначала проверка всего буфера, потом применение
 * (SYS-9): единица атомарности — система, и отказ на десятой команде из двадцати
 * не вправе оставить в мире первые девять.
 */
import {
  NO_ENTITY,
  type CommandOutcome,
  type CommandBuffer,
  type EntityId,
  type FieldHandle,
  type FieldOverrides,
  type WorldState,
} from '../types.js';
import { countCommands, nextSeq, record, traceFull, type DiagnosticsContext } from '../debug.js';
import * as world from './world.js';

/**
 * Вид команды в журнале. Числа, а не строки: вид читается на каждой команде в
 * трёх проходах (валидация, применение, точечное чтение), и `switch` по числу
 * не трогает памяти сверх самого журнала. `enum` для этого не годится — ядро
 * исполняется strip-only режимом Node, а `enum` порождает код.
 */
const KIND_SET_HANDLE = 0;
const KIND_SET_NAME = 1;
const KIND_DESTROY = 2;
/** Структурная команда: тело лежит объектом в `others`, журнал держит его индекс. */
const KIND_STRUCTURAL = 3;

/** Начальная ёмкость журнала: дальше удвоением, и на установившемся матче — ни разу. */
const INITIAL_CAPACITY = 64;

/**
 * Тело структурной команды. Необязательные `overrides` и `values` объявлены с
 * явным `| undefined`: они приезжают необязательным АРГУМЕНТОМ метода буфера
 * (`spawn(prefab, overrides?)`), и «аргумента не было» здесь неотличимо от
 * «переопределений нет» — так же их читают и проверка, и применение
 * (`checkSpawn`, `world.spawn`, `values?.[field]`). Наружу тело не уходит
 * вовсе: в трейс идёт только `commandData` (DIAG-2, DIAG-4).
 */
type Structural =
  | {
      readonly kind: 'spawn';
      readonly prefab: string;
      readonly overrides?: FieldOverrides | undefined;
    }
  | {
      readonly kind: 'addComponent';
      readonly component: string;
      readonly values?: Readonly<Record<string, number>> | undefined;
    }
  | { readonly kind: 'removeComponent'; readonly component: string };

/**
 * Что СТРУКТУРНАЯ команда ставит по адресу поля (CMD-5); `undefined` — эта
 * команда на адрес значения не ставит.
 *
 * Значение адресу ставит не только `setField`: `addComponent` на flush
 * переписывает все поля компонента (`values` → default схемы → нейтральное
 * значение типа, ECS-3, ECS-6), а `removeComponent` делает чтение поля
 * нейтралью ТИПА — после flush компонент сущности не принадлежит, а чтение
 * такого поля тотально (ECS-7, ECS-8). Порядок источников поэтому тот же, что
 * у мутатора в `world.ts`, а поле вне схемы (или незарегистрированный
 * компонент) ни состав, ни снятие не пишут вовсе: читатель падает обратно на
 * мир, который на такое имя отвечает по своим правилам (ECS-5).
 */
function structuralAnswer(
  state: WorldState,
  body: Structural,
  component: string,
  field: string,
): number | undefined {
  if (body.kind === 'spawn' || body.component !== component) return undefined;
  const schema = world.componentSchema(state, component);
  const type = schema?.fields[field];
  if (type === undefined) return undefined;
  const neutral = world.neutralValue(type);
  if (body.kind === 'removeComponent') return neutral;
  return body.values?.[field] ?? schema?.defaults?.[field] ?? neutral;
}

/**
 * Обвязка прохода применения при полном уровне трейса (DIAG-2, CMD-3). Исходы
 * копятся и уходят в трейс ПОСЛЕ прохода: перекрытие становится известно только
 * когда до мира дошла более поздняя запись в то же поле, то есть задним числом
 * относительно перекрытой команды. При выключенном трейсе записи нет вовсе — и
 * ни одной аллокации сверх обычного прохода.
 */
interface FlushTrace {
  readonly ctx: DiagnosticsContext;
  readonly outcomes: (CommandOutcome | undefined)[];
  /**
   * Индекс последней команды, писавшей в адрес поля: `сущность|handle`. Адрес
   * канонизирован handle'ом, а не именами: строковая и handle-команда на одно и
   * то же поле обязаны перекрывать друг друга, а не жить в двух разных ключах.
   */
  readonly lastWriter: Map<string, number>;
}

export interface CommandBufferHandle extends CommandBuffer {
  /**
   * Применяет накопленные команды к world state в порядке создания и очищает
   * буфер (CMD-2, CMD-3). Всё или ничего (SYS-9): отказ на любой команде
   * оставляет мир нетронутым, а буфер — накопленным.
   */
  flush(): void;
  /**
   * Начало тика: буфер привязывается к миру и очищается (SYS-9). Буфер живёт
   * дольше одного тика ради своих массивов, и очистка на ВХОДЕ в тик — то, чем
   * держится пост-условие оборванного тика: см. комментарий в `sim/tick.ts`.
   */
  reset(state: WorldState): void;
}

export function createCommandBuffer(initial: WorldState): CommandBufferHandle {
  let state = initial;

  // Журнал: вид, адресат, адрес и значение — по массиву на каждую величину.
  // Адресат и значение в Float64Array: EntityId 48-битный (ID-1), и i32 усёк бы
  // и цель команды, и записываемую ссылку на сущность (ECS-6).
  let capacity = INITIAL_CAPACITY;
  let kinds = new Uint8Array(capacity);
  let targets = new Float64Array(capacity);
  /** handle поля (KIND_SET_HANDLE) либо индекс в `others` (KIND_STRUCTURAL). */
  let addresses = new Int32Array(capacity);
  let payloads = new Float64Array(capacity);
  /**
   * Номер записи трейса, зарезервированный при ЗАКАЗЕ команды (DIAG-2):
   * порядок задаётся моментом создания, а не моментом применения, иначе
   * взаимный порядок команд и событий внутри системы был бы искажён. Минус
   * единица — полного трейса на этом тике нет вовсе.
   */
  let seqs = new Float64Array(capacity);
  /** Имена строкового адреса: слоты переиспользуются, как и весь журнал. */
  const components = new Array<string>(capacity).fill('');
  const fields = new Array<string>(capacity).fill('');
  let count = 0;

  /** Тела структурных команд; журнал ссылается на них индексом. */
  const others: Structural[] = [];

  /**
   * Сколько `destroy` в буфере. Счётчик, а не множество целей: он держит
   * обратный проход `alreadyDead` выключенным в подавляющем большинстве
   * буферов, где `destroy` нет вовсе, и не стоит ни одной аллокации.
   */
  let destroys = 0;

  /**
   * Сколько записей поля адресовано handle'ом. Счётчик той же природы, что
   * `destroys`: он избавляет точечное чтение от разрешения имени в handle там,
   * где handle-команд в буфере нет вовсе, — то есть на сцене из одних лишь
   * систем, описанных данными.
   */
  let handleWrites = 0;

  /** Удвоение журнала: содержимое переезжает целиком, слоты остаются на местах. */
  function grow(): void {
    const next = capacity * 2;
    const grownKinds = new Uint8Array(next);
    grownKinds.set(kinds);
    kinds = grownKinds;
    const grownTargets = new Float64Array(next);
    grownTargets.set(targets);
    targets = grownTargets;
    const grownAddresses = new Int32Array(next);
    grownAddresses.set(addresses);
    addresses = grownAddresses;
    const grownPayloads = new Float64Array(next);
    grownPayloads.set(payloads);
    payloads = grownPayloads;
    const grownSeqs = new Float64Array(next);
    grownSeqs.set(seqs);
    seqs = grownSeqs;
    while (components.length < next) components.push('');
    while (fields.length < next) fields.push('');
    capacity = next;
  }

  /** Номер записи резервируется здесь — в момент заказа команды (DIAG-2, DIAG-5). */
  function push(kind: number, target: EntityId, address: number, payload: number): number {
    if (count === capacity) grow();
    const at = count;
    kinds[at] = kind;
    targets[at] = target;
    addresses[at] = address;
    payloads[at] = payload;
    const traced = traceFull();
    seqs[at] = traced === undefined ? -1 : nextSeq(traced);
    count++;
    return at;
  }

  /** Структурная команда: тело — в боковой список, журналу — его индекс. */
  function pushStructural(target: EntityId, body: Structural): void {
    const at = others.length;
    others.push(body);
    push(KIND_STRUCTURAL, target, at, 0);
  }

  function structuralAt(index: number): Structural {
    return others[addresses[index]!]!;
  }

  /**
   * Значение, которое команда `index` ставит адресу поля; `undefined` — эта
   * команда на него не пишет. Адрес приезжает разом в двух видах — именами и
   * handle'ом, — потому что журнал хранит и то и другое (CMD-1), а отвечать
   * точечное чтение обязано о ПОЛЕ, а не о способе адресации (CMD-5).
   */
  function pendingAt(
    index: number,
    component: string,
    field: string,
    handle: FieldHandle | undefined,
  ): number | undefined {
    switch (kinds[index]) {
      case KIND_SET_HANDLE:
        // `handle` не разрешён (имени нет в мире) — совпасть с числом он не может.
        return addresses[index] === handle ? payloads[index] : undefined;
      case KIND_SET_NAME:
        return components[index] === component && fields[index] === field
          ? payloads[index]
          : undefined;
      case KIND_STRUCTURAL:
        return structuralAnswer(state, structuralAt(index), component, field);
      default:
        return undefined;
    }
  }

  /** Спавн адресата не имеет — единственная команда, живой проверки не требующая. */
  function isSpawn(index: number): boolean {
    return kinds[index] === KIND_STRUCTURAL && structuralAt(index).kind === 'spawn';
  }

  /**
   * Убила ли цель одна из предыдущих команд этого же буфера. Проход по уже
   * накопленному, а не множество уничтоженных: `destroy` в буфере единицы, а Set
   * стоил бы аллокации на каждом тике (тот же приём и та же причина, что у
   * `peekField`).
   */
  function alreadyDead(upto: number, target: EntityId): boolean {
    if (destroys === 0) return false;
    for (let i = 0; i < upto; i++) {
      if (kinds[i] === KIND_DESTROY && targets[i] === target) return true;
    }
    return false;
  }

  /**
   * Проход валидации перед применением (SYS-9). Всё, на чём мог бы бросить
   * проход применения, проверяется здесь — до первой мутации мира: иначе
   * исключение посреди применения оставило бы в мире часть команд упавшей
   * системы, а единица атомарности у flush'а — система целиком.
   *
   * Условия и сообщения не копируются: их держит `world.ts` рядом с самими
   * мутаторами, и оба прохода читают одни и те же функции. Команда, адресованная
   * handle'ом, проверяется по плоской таблице полей: существование компонента и
   * поля доказано разрешением имени (SYS-10), и остаётся представимость
   * значения (ECS-3).
   *
   * Аллокаций проход не делает — только счёт по уже накопленным записям.
   */
  function validate(): void {
    // Ёмкость: `spawn` берёт слот из freeList, иначе очередной индекс (ID-2), а
    // `destroy` внутри этого же прохода возвращает слот в пул.
    let room = world.spawnRoom(state);
    for (let i = 0; i < count; i++) {
      const kind = kinds[i]!;
      if (kind === KIND_STRUCTURAL) {
        const body = structuralAt(i);
        if (body.kind === 'spawn') {
          world.checkSpawn(state, body.prefab, body.overrides);
          world.checkSpawnRoom(state, room);
          room--;
          continue;
        }
      }
      const target = targets[i]!;
      // Та же проверка живой цели, что у прохода применения: команда, которую он
      // отбросит, до мутатора не дойдёт и проверяться не должна.
      if (!world.isAlive(state, target) || alreadyDead(i, target)) continue;
      switch (kind) {
        case KIND_SET_HANDLE:
          world.checkFieldByHandle(state, addresses[i] as FieldHandle, payloads[i]!);
          break;
        case KIND_SET_NAME:
          world.checkField(state, 'setField', components[i]!, fields[i]!, payloads[i]);
          break;
        case KIND_DESTROY:
          room++;
          break;
        default: {
          // Вместе с составом проверяются и значения: непредставимое значение —
          // отказ записи (ECS-3), и узнать о нём обязан этот проход, а не мир.
          // `removeComponent` тотален: незарегистрированный компонент — no-op,
          // а не отказ, и проверять ему нечего.
          const body = structuralAt(i);
          if (body.kind === 'addComponent') {
            world.checkComponent(state, 'addComponent', body.component, body.values);
          }
          break;
        }
      }
    }
  }

  /** Применение одной команды к миру (CMD-3): порядок — порядок создания. */
  function applyCommand(index: number): void {
    const target = targets[index]!;
    switch (kinds[index]!) {
      case KIND_SET_HANDLE:
        world.setFieldByHandle(state, target, addresses[index] as FieldHandle, payloads[index]!);
        break;
      case KIND_SET_NAME:
        world.setField(state, target, components[index]!, fields[index]!, payloads[index]!);
        break;
      case KIND_DESTROY:
        world.destroy(state, target);
        break;
      default: {
        const body = structuralAt(index);
        if (body.kind === 'spawn') world.spawn(state, body.prefab, body.overrides);
        else if (body.kind === 'addComponent') {
          world.addComponent(state, target, body.component, body.values);
        } else world.removeComponent(state, target, body.component);
        break;
      }
    }
  }

  /**
   * Адрес поля команды записи — числом. Строковая команда разрешает имена ровно
   * здесь и только под трейсом: путь применения имён не резолвит (это делает
   * мутатор), а перекрытие обязано считаться по ОДНОМУ адресу для обоих каналов.
   * Имена к этому моменту проверены (`validate`), поэтому `-1` недостижим.
   */
  function addressOf(index: number): number {
    if (kinds[index] === KIND_SET_HANDLE) return addresses[index]!;
    return world.lookupFieldHandle(state, components[index]!, fields[index]!) ?? -1;
  }

  /** Данные записи о команде (DIAG-2): только скаляры, ссылок на мир нет (DIAG-4). */
  function commandData(index: number): Readonly<Record<string, number | string>> {
    const target = targets[index]!;
    switch (kinds[index]!) {
      case KIND_SET_HANDLE: {
        // Имена — из плоской таблицы полей: handle есть адрес в ней (SYS-10), и
        // запись о команде поэтому та же самая, что у строкового канала.
        const address = addresses[index] as FieldHandle;
        return {
          cmd: 'setField',
          entity: target,
          component: world.componentNameOf(state, address),
          field: world.fieldNameOf(state, address),
          value: payloads[index]!,
        };
      }
      case KIND_SET_NAME:
        return {
          cmd: 'setField',
          entity: target,
          component: components[index]!,
          field: fields[index]!,
          value: payloads[index]!,
        };
      case KIND_DESTROY:
        return { cmd: 'destroy', entity: target };
      default: {
        const body = structuralAt(index);
        if (body.kind === 'spawn') return { cmd: body.kind, prefab: body.prefab };
        return { cmd: body.kind, entity: target, component: body.component };
      }
    }
  }

  /** Исход применённой команды и перекрытие предыдущей записи в тот же адрес (CMD-3). */
  function noteApplied(trace: FlushTrace, index: number): void {
    trace.outcomes[index] = 'applied';
    const kind = kinds[index];
    if (kind !== KIND_SET_HANDLE && kind !== KIND_SET_NAME) return;
    const key = `${targets[index]!}|${addressOf(index)}`;
    const previous = trace.lastWriter.get(key);
    // Значение предыдущей команды до мира дошло, но было перезаписано этой — для
    // наблюдателя оно потеряно бесследно (CMD-3).
    if (previous !== undefined) trace.outcomes[previous] = 'overwritten';
    trace.lastWriter.set(key, index);
  }

  /** Записи о командах буфера — одним проходом после применения (DIAG-2, DIAG-5). */
  function traceCommands(trace: FlushTrace): void {
    for (let i = 0; i < count; i++) {
      const seq = seqs[i]!;
      const outcome = trace.outcomes[i];
      record(trace.ctx, 'command', 'info', 'COMMAND', {
        ...(seq >= 0 ? { seq } : {}),
        data: commandData(i),
        ...(outcome !== undefined ? { outcome } : {}),
      });
    }
  }

  /** Очистка журнала: слоты остаются выделенными и достаются следующему тику. */
  function clear(): void {
    count = 0;
    destroys = 0;
    handleWrites = 0;
    // Тела структурных команд отпускаются: иначе буфер держал бы за собой
    // переопределения полей и после того, как команда применена.
    others.length = 0;
  }

  return {
    spawn(prefab, overrides) {
      pushStructural(NO_ENTITY, { kind: 'spawn', prefab, overrides });
    },
    destroy(entity) {
      push(KIND_DESTROY, entity, -1, 0);
      destroys++;
    },
    addComponent(entity, component, values) {
      pushStructural(entity, { kind: 'addComponent', component, values });
    },
    removeComponent(entity, component) {
      pushStructural(entity, { kind: 'removeComponent', component });
    },
    setField(entity, component, field, value) {
      const at = push(KIND_SET_NAME, entity, -1, value);
      components[at] = component;
      fields[at] = field;
    },
    setFieldByHandle(entity, handle, value) {
      push(KIND_SET_HANDLE, entity, handle, value);
      handleWrites++;
    },
    /**
     * CMD-5: точечное чтение уже отложенного. Обратный проход — потому что
     * побеждает последняя команда на поле, как и на flush (CMD-3).
     *
     * Адрес спрашивают именами, а в журнале он бывает и handle'ом: имя
     * разрешается в handle ОДИН раз на вызов — и только если handle-команды в
     * буфере вообще есть. Сравниваются после этого числа, а не строки.
     *
     * Значение адресу ставит не только `setField`, но и структурная команда —
     * отложенные `addComponent` и `removeComponent`; за них отвечает
     * `structuralAnswer`: иначе чтение разошлось бы с тем, что окажется в мире
     * после flush (CMD-5).
     *
     * ponytail: O(команд в буфере) на вызов. Буфер флашится в конце каждой
     * системы, поэтому список короткий; индекс по адресу поля — когда
     * распределение слотов станет горячим.
     */
    peekField(entity, component, field) {
      const handle = handleWrites === 0 ? undefined : world.lookupFieldHandle(state, component, field);
      for (let i = count - 1; i >= 0; i--) {
        if (targets[i] !== entity) continue;
        const pending = pendingAt(i, component, field, handle);
        if (pending !== undefined) return pending;
      }
      return undefined;
    },
    flush() {
      // Сначала весь буфер проверяется, и только потом применяется: ниже по
      // тексту действует инвариант «проход применения не бросает» (SYS-9).
      validate();

      const ctx = traceFull();
      const trace: FlushTrace | undefined =
        ctx === undefined ? undefined : { ctx, outcomes: [], lastWriter: new Map() };
      let applied = 0;

      for (let i = 0; i < count; i++) {
        // Команда, адресованная уже умершей сущности, отбрасывается: иначе она
        // применилась бы к новой сущности, занявшей тот же слот (смысл
        // поколений в ID-1). Актуально для команд, созданных до того, как
        // предыдущая команда в этом же буфере убила цель.
        if (!isSpawn(i) && !world.isAlive(state, targets[i]!)) {
          if (trace !== undefined) trace.outcomes[i] = 'dropped:dead-target';
          continue;
        }
        applied++;
        if (trace !== undefined) noteApplied(trace, i);
        applyCommand(i);
      }

      // Счётчики нужны записи `systemEnd` и на уровне границ систем, где
      // потока команд нет вовсе (DIAG-3).
      countCommands(count, applied);

      if (trace !== undefined) traceCommands(trace);

      clear();
    },
    reset(next) {
      state = next;
      clear();
    },
  };
}
