/**
 * KeyedInstanceSet — механизм набора инстансов с устойчивыми ключами, общий
 * документному источнику (REND-11) и набору декораций (REND-18).
 *
 * Наборы РАЗНЫЕ и таковыми остаются: продюсеры presentation-состояния
 * взаимоисключающи, а декорации сосуществуют с любым из них — почему именно так,
 * сказано в шапках `documentSource.ts` и `decorations.ts`. Механизм же нормирован
 * ОДИН раз (REND-3), и потому здесь он один: сведение полного набора с текущим —
 * ключ, которого не было, создаёт инстанс, исчезнувший ключ убирает,
 * сохранившийся обновляет; смена вида пересоздаёт инстанс под тем же ключом;
 * дублирующийся ключ в наборе — ошибка, а не молча выигравшая последняя запись.
 *
 * Чем наборы отличаются, видно у них же, а не здесь: набор отдаёт функцию записи
 * полей (`write`) и публикует результат сам — своим входом сцены.
 *
 * Нумерация сущностей набора — собственная. Это НЕ ссылки на сущности мира, и
 * между наборами номера не пересекаются по смыслу: это адреса инстансов набора.
 * Возврат ключа даёт новый номер: инстанс создаётся заново (REND-11).
 */
import type { EntityId } from '@fluxus/core';
import { LOCOMOTION_NORMAL } from '@fluxus/core';
import type { EntityView } from './types.js';

/** Что механизм требует от записи набора: ключ, вид и позиция (REND-11, REND-18). */
export interface KeyedInstance {
  /**
   * Идентичность размещённого в документе. Устойчивость ключа между наборами —
   * единственное, что механизм требует от формата: позиция в массиве ключом
   * быть не может (удаление соседа сдвинуло бы ключи всего хвоста).
   */
  readonly key: string;
  /** Визуальный вид — ключ манифеста визуалов; null — не рисуется. */
  readonly kind: string | null;
  /** Позиция в мировых единицах. */
  readonly x: number;
  readonly y: number;
}

export interface KeyedInstanceSetOptions<TInstance extends KeyedInstance> {
  /** Имя набора в сообщении о дублирующемся ключе — `DocumentSource`, `DecorationSet`. */
  readonly owner: string;
  /** ID требования, которое набор в этом сообщении цитирует. */
  readonly requirement: string;
  /** Поля инстанса из записи набора — единственное, чем наборы отличаются. */
  readonly write: (view: EntityView, instance: TInstance) => void;
}

export class KeyedInstanceSet<TInstance extends KeyedInstance> {
  /** Инстансы набора — тот же контейнер, что видят подсистемы. */
  readonly entities = new Map<EntityId, EntityView>();

  private readonly options: KeyedInstanceSetOptions<TInstance>;
  private readonly idByKey = new Map<string, EntityId>();
  private readonly keyById = new Map<EntityId, string>();
  private readonly seen = new Set<string>();
  private nextId: EntityId = 1;

  constructor(options: KeyedInstanceSetOptions<TInstance>) {
    this.options = options;
  }

  /** Сколько инстансов в текущем наборе. */
  get size(): number {
    return this.entities.size;
  }

  /** ID инстанса набора по ключу документа; undefined — ключа в наборе нет. */
  entityOf(key: string): EntityId | undefined {
    return this.idByKey.get(key);
  }

  /** Обратное отображение — ключ документа по ID инстанса (picking ED-17). */
  keyOf(entity: EntityId): string | undefined {
    return this.keyById.get(entity);
  }

  /**
   * Сводит полный набор с текущим (REND-3). Публикацию результата механизм на
   * себя не берёт: у продюсера и у набора декораций входы сцены разные.
   */
  apply(instances: Iterable<TInstance>): void {
    const seen = this.seen;
    seen.clear();

    for (const instance of instances) {
      if (seen.has(instance.key)) {
        throw new Error(
          `${this.options.owner}: ключ "${instance.key}" встречается в наборе дважды (${this.options.requirement})`,
        );
      }
      seen.add(instance.key);

      const id = this.idByKey.get(instance.key);
      let view = id === undefined ? undefined : this.entities.get(id);
      // Смена вида — другая модель и другая запись манифеста: пересоздание тут
      // не «мигание объектом», а единственно верное поведение. Ключ при этом
      // остаётся ключом того же размещённого.
      if (view !== undefined && view.kind !== instance.kind) {
        this.drop(instance.key);
        view = undefined;
      }
      if (view === undefined) {
        this.options.write(this.create(instance), instance);
      } else {
        view.spawned = false;
        this.options.write(view, instance);
      }
    }

    for (const key of this.idByKey.keys()) {
      if (!seen.has(key)) this.drop(key);
    }
  }

  /**
   * Инстанс набора в состоянии покоя: всё, что производно от идущего мира, у
   * размещённого объекта отсутствует — скорости нет (состояние анимации покой,
   * REND-4), манёвра и полёта не бывает (REND-12), цели каста нет (REND-5),
   * уровень производен от позиции (посадку делает визуальная поверхность,
   * REND-9, REND-10). Остальное дописывает `write` набора.
   */
  private create(instance: TInstance): EntityView {
    const id = this.nextId++;
    const view: EntityView = {
      id,
      kind: instance.kind,
      prevX: instance.x,
      prevY: instance.y,
      currX: instance.x,
      currY: instance.y,
      prevLevel: 0,
      currLevel: 0,
      snap: true,
      spawned: true,
      moving: false,
      motion: LOCOMOTION_NORMAL,
      prevMotion: LOCOMOTION_NORMAL,
      prevMotionPhase: Number.NaN,
      currMotionPhase: Number.NaN,
      flightPhase: Number.NaN,
      levelOverride: false,
      facingYaw: 0,
      aimYaw: null,
      states: 0,
    };
    this.entities.set(id, view);
    this.idByKey.set(instance.key, id);
    this.keyById.set(id, instance.key);
    return view;
  }

  private drop(key: string): void {
    const id = this.idByKey.get(key);
    if (id === undefined) return;
    this.idByKey.delete(key);
    this.keyById.delete(id);
    this.entities.delete(id);
  }
}
