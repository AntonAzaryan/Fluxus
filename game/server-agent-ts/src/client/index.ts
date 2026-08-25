/**
 * Клиентская библиотека управляющего протокола — подпуть
 * `@fluxus/server-agent/client`.
 *
 * Подпутём, потому что корень пакета поднимает самого агента: странице менеджера
 * (`server-manager` MGR-1) нужен клиент, а не `node:https` и не супервизор
 * процессов.
 *
 * Фабрика канала выбирается вызывающим: `browserSocket` — страница, где
 * сертификат каналу не виден (граница названа в самом модуле), `nodeSocket` —
 * настоящий TOFU поверх TLS, и живёт он ОТДЕЛЬНЫМ подпутём
 * (`@fluxus/server-agent/client/node`).
 *
 * Отдельным потому, что он тянет `ws` и `node:tls`: попади он в этот барьер,
 * сборка страницы менеджера тащила бы за собой узловые модули — не «лишние
 * байты», а зависимость браузерного приложения от того, чего в браузере нет.
 */
export {
  ControlClientError,
  createControlClient,
  type ClientFailure,
  type ConnectOptions,
  type ConnectedAgent,
  type ControlClient,
  type ControlSocket,
  type ControlSocketFactory,
  type OpenedSocket,
} from './controlClient.js';
export { browserSocket } from './browserSocket.js';
