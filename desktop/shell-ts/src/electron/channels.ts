/**
 * Имена каналов IPC между главным процессом и preload — деталь реализации
 * Electron, а не контракт границы. В `src/bridge/` их нет намеренно: страница
 * говорит с мостом, а не с транспортом, и вторая реализация контейнера вправе
 * не иметь IPC вовсе (DSK-6).
 *
 * Эти же имена повторены в `preload.cjs`, и повтор вынужденный: preload в
 * песочнице — самодостаточный CommonJS-файл, которому `require` соседнего
 * модуля недоступен. Чтобы повтор не разъехался, его стережёт тест гейта
 * `test/electronGlue.test.ts` — он читает оба файла текстом и сверяет списки;
 * Electron для этого не нужен.
 */

export const CHANNELS = {
  /** Синхронный запрос описания сессии: страница получает его до первого кадра. */
  session: 'fluxus:session',
  read: 'fluxus:read',
  stat: 'fluxus:stat',
  list: 'fluxus:list',
  write: 'fluxus:write',
  watchOn: 'fluxus:watch-on',
  watchOff: 'fluxus:watch-off',
  /** Главный процесс → страница: изменение в наблюдаемом корне. */
  change: 'fluxus:change',
  choose: 'fluxus:choose',
  title: 'fluxus:title',
  unsaved: 'fluxus:unsaved',
  /** Главный процесс → страница: «можно закрывать?». */
  closeRequest: 'fluxus:close-request',
  /** Страница → главный процесс: ответ на запрос закрытия. */
  closeReply: 'fluxus:close-reply',
  serviceStart: 'fluxus:service-start',
  serviceStop: 'fluxus:service-stop',
  serviceState: 'fluxus:service-state',
} as const;

export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];
