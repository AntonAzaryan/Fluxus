/**
 * Публикация сессии на десктопе (`net-session` SES-3): поднять свой стенд матча
 * и узнать его адрес.
 *
 * SES-3 называет рандеву двумя половинами — «опубликовать сессию» у основателя
 * и «разрешить сессию в транспорт» у присоединяющегося. Вторая у демо есть
 * давно (`rendezvous.ts`, прямой адрес); здесь появляется первая, и появляется
 * ровно там, где хост вправе порождать процессы, — в десктоп-контейнере
 * (`desktop-shell` DSK-7). В вебе страница процесс не поднимает и поднять не
 * может: там стенд заводит dev-сервер (`demoStand.ts`) либо человек руками.
 *
 * Признак десктопа — наличие моста в странице и объявленный профилем сервис, а
 * не флаг сборки: бандл один и тот же (DSK-1), как и у редактора.
 *
 * Мост живёт ТОЛЬКО в главном потоке — preload кладёт его в страницу, а не в
 * воркер, — поэтому стенд поднимается здесь, а его адрес уезжает клиенту тем
 * же путём, что и адрес из `?server=`: строкой в конверте сборки. Второго
 * канала «как добраться до сервера» у демо не появляется (SES-2).
 */
import {
  desktopBridgeOf,
  sessionGrants,
  type DesktopBridge,
} from '@fluxus/desktop-shell/bridge';

/**
 * Имя сервиса стенда. То же, что в `desktop/shell-ts/apps/game.app.json`:
 * страница знает об объявленном сервисе ровно имя и ничего сверх него (DSK-7).
 */
export const DEMO_STAND_SERVICE = 'match-stand';

export interface DemoStandHost {
  /** Поднять стенд и вернуть его адрес; отказ — исключение с причиной. */
  publish(): Promise<string>;
  /** Работает ли стенд прямо сейчас: адрес либо пустая строка. */
  address(): Promise<string>;
}

/**
 * Хозяин стенда, если страница открыта там, где его можно поднять. `undefined`
 * — обычная веб-вкладка: кнопки нет, и это не деградация, а другая среда.
 */
export function demoStandHost(scope: unknown): DemoStandHost | undefined {
  const bridge: DesktopBridge | undefined = desktopBridgeOf(scope);
  if (bridge === undefined) return undefined;
  if (!sessionGrants(bridge.session, 'service')) return undefined;
  if (!bridge.session.services.includes(DEMO_STAND_SERVICE)) return undefined;
  const { startService, serviceState } = bridge;
  if (startService === undefined || serviceState === undefined) return undefined;
  return {
    async publish() {
      const state = await startService(DEMO_STAND_SERVICE);
      if (!state.running || state.address === '') {
        throw new Error('контейнер не поднял стенд матча');
      }
      return state.address;
    },
    async address() {
      return (await serviceState(DEMO_STAND_SERVICE)).address;
    },
  };
}
