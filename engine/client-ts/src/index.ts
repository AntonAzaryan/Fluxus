// Клиентская оболочка веб-игры (capability client-shell): ядро в dedicated
// Worker, рендер в главном потоке, канал — transferable ping-pong. Режимов ровно
// два (SHELL-8): локальный — симуляция в воркере (`WorkerShell`), сетевой —
// клиент матча и применение персональных снапшотов (`NetworkShell`).

// Протокол канала и абстракция порта (SHELL-3, SHELL-5, SHELL-6, SHELL-8).
export { helloMessage, shellPort } from './protocol.js';
export type {
  ControlMessage,
  HelloMessage,
  InputMessage,
  MainToWorker,
  PauseEnvelope,
  ReturnBufferMessage,
  ShellMode,
  ShellPort,
  TickEnvelope,
  WorkerToMain,
} from './protocol.js';

// Кодек плоского буфера — транспорт-независимая раскладка (SHELL-3).
export { CODEC_VERSION, readTick, requiredBytes, writeTick } from './codec.js';
export type { WriteOverrides } from './codec.js';

// Воркер-сторона: сериализация с ack-conflation, общая для обоих режимов.
export { ShellSender } from './sender.js';
export type { SenderOptions } from './sender.js';
// Локальный режим: хост симуляции с тикером (SHELL-8).
export { WorkerShell } from './workerShell.js';
export type { ShellHistory, ShellScrubOptions, WorkerShellConfig } from './workerShell.js';
// Сетевой режим: клиент матча и применение персональных снапшотов (SHELL-8, NTR-10).
export { NetworkShell } from './networkShell.js';
export type { ControlButtons, NetworkShellConfig } from './networkShell.js';

// Main-сторона: зеркало RenderHost за каналом (SHELL-2).
export { RemoteHost } from './remoteHost.js';
export type { RemoteHostConfig } from './remoteHost.js';

// Слой источников ввода (input-devices INP-1..5): устройства → канонический ввод.
export { TURN_UNITS, aimAngle, aimTarget } from './input/types.js';
export type {
  ActionSink,
  AimPoint,
  AimResolution,
  ContinuousSample,
  InputSource,
  MutableAimPoint,
} from './input/types.js';
export { HeldActions, InputSampler, toWorldFixed } from './input/sampler.js';
export type { CanonicalInput, SamplerOptions } from './input/sampler.js';
export { KeyboardMouseSource } from './input/keyboardMouse.js';
export { POINTER_MODIFIERS, pointerAction, pointerSuppressed } from './input/keyboardMouse.js';
export type {
  KeyboardMouseBindings,
  KeyboardMouseOptions,
  PointerButtonBinding,
  PointerModifier,
  PointerModifierState,
} from './input/keyboardMouse.js';
export { TouchSource } from './input/touch.js';
export type {
  TouchBindings,
  TouchOverlayState,
  TouchViewport,
  TouchZone,
} from './input/touch.js';
export { GamepadSource, navigatorGamepad } from './input/gamepad.js';
export type { GamepadBindings, GamepadLike } from './input/gamepad.js';
export { validateBindings } from './input/bindings.js';
export type { InputBindings } from './input/bindings.js';

// Транспорт netcode поверх пары портов — локальный сервер во втором воркере.
export { portTransport } from './portTransport.js';
