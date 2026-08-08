/**
 * Реестр операций авторинга — тот самый реестр вкладов ED-25, из которого
 * строится и интерфейс, и машинный каталог ED-30. Поверхность узкая нарочно:
 * зарегистрировать, спросить, перечислить. Всё, что сверх этого, пришлось бы
 * повторить каждому потребителю реестра.
 *
 * Второго набора операций не существует: набор, доступный без интерфейса, и
 * набор, доступный из интерфейса, — один и тот же объект (ED-29).
 */
import {
  SESSION_SCOPED_TYPES,
  type AuthoringOperation,
  type OperationParamType,
} from './types.js';

export interface OperationRegistry {
  /**
   * Повторная регистрация того же `id` — ошибка, а не замена. Молчаливая
   * замена сделала бы порядок регистрации вкладов значимым, то есть заставила
   * бы новый вклад знать про существующие (ED-25).
   */
  register(operation: AuthoringOperation): void;
  has(id: string): boolean;
  get(id: string): AuthoringOperation | undefined;
  /** Порядок — по `id`: каталог ED-30 не должен зависеть от порядка регистрации. */
  list(): readonly AuthoringOperation[];
}

export function createOperationRegistry(): OperationRegistry {
  const operations = new Map<string, AuthoringOperation>();
  return {
    register(operation) {
      if (operation.id === '') throw new Error('операция без id не регистрируется');
      if (operations.has(operation.id)) {
        throw new Error(`операция "${operation.id}" уже зарегистрирована`);
      }
      // Ключ описания обязателен и у операции, и у каждого её параметра: без
      // него запись каталога (ED-30) приходит к внешнему потребителю с пустым
      // описанием, а пустое от отсутствующего он не отличит (ED-28).
      if (operation.descriptionKey.trim() === '') {
        throw new Error(`операция "${operation.id}": пустой ключ описания`);
      }
      for (const [name, spec] of Object.entries(operation.params)) {
        if (spec.descriptionKey.trim() === '') {
          throw new Error(`операция "${operation.id}": пустой ключ описания параметра "${name}"`);
        }
      }
      operations.set(operation.id, operation);
    },
    has: (id) => operations.has(id),
    get: (id) => operations.get(id),
    list: () => [...operations.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
}

/** Параметр в машинном каталоге (ED-30). Сериализуем как есть — без функций и ссылок. */
export interface OperationParamDescription {
  readonly name: string;
  readonly type: OperationParamType;
  readonly optional: boolean;
  /**
   * Значение параметра живёт только в текущей сессии. Явно, а не выводимо из
   * типа читателем каталога: сессионность дескрипторов — плата за отказ от
   * поля-идентификатора в формате, и внешний потребитель обязан о ней знать.
   */
  readonly sessionScoped: boolean;
  readonly descriptionKey: string;
}

export interface OperationDescription {
  readonly id: string;
  readonly descriptionKey: string;
  readonly params: readonly OperationParamDescription[];
}

/**
 * Само-описание набора операций (ED-30). Строится из реестра в момент запроса:
 * отдельно поддерживаемого описания не существует — оно разошлось бы с
 * реестром на первой же новой операции.
 */
export function describeOperations(registry: OperationRegistry): readonly OperationDescription[] {
  return registry.list().map((operation) => ({
    id: operation.id,
    descriptionKey: operation.descriptionKey,
    params: Object.keys(operation.params)
      .sort()
      .map((name) => {
        const spec = operation.params[name]!;
        return {
          name,
          type: spec.type,
          optional: spec.optional === true,
          sessionScoped: SESSION_SCOPED_TYPES.has(spec.type),
          descriptionKey: spec.descriptionKey,
        };
      }),
  }));
}
