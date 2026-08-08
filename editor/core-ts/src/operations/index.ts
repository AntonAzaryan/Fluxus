/**
 * Слой операций авторинга (ED-29) и его само-описание (ED-30).
 *
 * Реестр здесь один и тот же для интерфейса и для вызова без интерфейса —
 * второго, параллельного способа править документы не существует.
 */
export { createOperationRegistry, describeOperations } from './registry.js';
export type { OperationDescription, OperationParamDescription, OperationRegistry } from './registry.js';
export {
  AUTHORING_ACTIONS,
  AUTHORING_SUSPENDED,
  AuthoringSuspendedError,
  OPERATION_PARAM_TYPES,
  OperationError,
  SESSION_SCOPED_TYPES,
} from './types.js';
export type {
  AuthoringAction,
  AuthoringOperation,
  OperationContext,
  OperationParams,
  OperationParamSpec,
  OperationParamType,
} from './types.js';
export { BUILTIN_OPERATIONS, registerBuiltinOperations } from './builtin.js';
export { runOperationRoundTrip } from './conformance.js';
export type { RoundTripFinding, RoundTripResult } from './conformance.js';
