// Клиентская оболочка веб-игры (client-shell SHELL-1..7): ядро в dedicated
// Worker, рендер в главном потоке, канал — transferable ping-pong.

// Протокол канала и абстракция порта (SHELL-3, SHELL-5, SHELL-6).
export { shellPort } from './protocol.js';
export type {
  ControlMessage,
  HelloMessage,
  InputMessage,
  MainToWorker,
  ReturnBufferMessage,
  ShellPort,
  TickEnvelope,
  WorkerToMain,
} from './protocol.js';

// Кодек плоского буфера — транспорт-независимая раскладка (SHELL-3).
export { CODEC_VERSION, readTick, requiredBytes, writeTick } from './codec.js';
export type { WriteOverrides } from './codec.js';

// Воркер-сторона: сериализация с ack-conflation и хост симуляции.
export { ShellSender } from './sender.js';
export type { SenderOptions } from './sender.js';
export { WorkerShell } from './workerShell.js';
export type { WorkerShellConfig } from './workerShell.js';

// Main-сторона: зеркало RenderHost за каналом (SHELL-2).
export { RemoteHost } from './remoteHost.js';
export type { RemoteHostConfig } from './remoteHost.js';

// Транспорт netcode поверх пары портов — локальный сервер во втором воркере.
export { portTransport } from './portTransport.js';
