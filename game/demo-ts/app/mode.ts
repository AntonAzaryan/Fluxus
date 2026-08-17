/**
 * Режим страницы демо (`client-shell` SHELL-8, design D1/D4).
 *
 * Режимов оболочки ровно два — `local` и `network`, — и выбираются они ПРИ
 * СТАРТЕ страницы, а не переключаются в рантайме. Здесь это буквально: режим
 * выводится из строки запроса один раз, до создания воркеров, и сменить его
 * можно только перезагрузкой с другим параметром. Кнопка «играть по сети»
 * поэтому и есть переход по URL, а не тумблер.
 *
 * Дефолт — матч против бота на сетевом стеке (D1): каждый запуск демо гоняет
 * тот же код, что сетевой матч. Старый одиночный `WorkerShell` остаётся под
 * `?solo` — там живут пауза и отладочная перемотка, которых у тонкого клиента
 * нет и быть не может (`netcode` NET-11, `snapshot-rewind` REW-6).
 */

/**
 * Порт стенда демо-арены — константа СБОРКИ (D4): лобби, списка серверов и
 * авторизации у демо нет. Адрес целиком константой БЫТЬ НЕ МОЖЕТ — см.
 * `demoServerUrl`.
 */
export const DEMO_SERVER_PORT = 8080;

/** Хост стенда, когда вывести его из страницы нечем (`file:`, пустой hostname). */
const LOOPBACK = '127.0.0.1';

/** Та часть адреса страницы, из которой выводится адрес стенда. */
export interface PageOrigin {
  readonly protocol: string;
  readonly hostname: string;
}

/**
 * Адрес стенда по умолчанию — ВЫВОД ИЗ СТРАНИЦЫ, а не зашитый loopback.
 *
 * Причина ровно одна, и она про игру вдвоём: страницу демо второй игрок
 * открывает по адресу ПЕРВОГО, и зашитый `127.0.0.1` увёл бы его на его же
 * машину, где стенда нет. Хост берётся у страницы, потому что стенд и страницу
 * поднимает одна и та же машина (`bin/demo-serve.mjs` слушает все интерфейсы),
 * а порт остаётся константой сборки: списка серверов у демо нет.
 *
 * Схема выводится вместе с хостом: со страницы по `https` браузер блокирует
 * `ws://` как mixed content, и единственный работающий вариант там — `wss://`.
 * Дать заведомо заблокированный адрес значило бы отчитаться о соединении,
 * которого не будет.
 *
 * Пустой `hostname` — это не браузерная вкладка (`file:` десктоп-контейнера,
 * `about:blank` теста): выводить не из чего, и остаётся loopback — там стенд
 * поднят тем же хостом, что и страница.
 */
export function demoServerUrl(page: PageOrigin): string {
  const host = page.hostname === '' ? LOOPBACK : page.hostname;
  const scheme = page.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}:${DEMO_SERVER_PORT}`;
}

export type DemoMode =
  /** Одиночная симуляция в воркере: прежняя сборка, пауза и перемотка (SHELL-8, `local`). */
  | { readonly kind: 'solo' }
  /** Матч против бота, поднятый прямо во вкладке (`net-session` SES-1, `local`). */
  | { readonly kind: 'local' }
  /** Выделенный стенд по выведенному адресу либо из `?server=` (SES-1, `dedicated`). */
  | { readonly kind: 'server'; readonly url: string };

/** Режим из строки запроса страницы. Пустой `?server=` считается «адрес страницы». */
export function demoMode(search: string, page: PageOrigin): DemoMode {
  const params = new URLSearchParams(search);
  if (params.has('solo')) return { kind: 'solo' };
  if (!params.has('server')) return { kind: 'local' };
  const url = params.get('server');
  return { kind: 'server', url: url === null || url === '' ? demoServerUrl(page) : url };
}

/**
 * Порядок попыток занять слот (D4): первый пришедший получает первый слот, а
 * получивший отказ пробует следующий. У матча, поднятого своей же вкладкой,
 * кандидат один — второй слот держит бот-заполнитель (BOT-7), и отбирать его у
 * себя незачем.
 *
 * Перебор — это способ ОБОЙТИСЬ БЕЗ лобби, а не замена ему: лобби назначает
 * идентификатор игрока до матча (SES-4), и кандидат у него ровно один. Поэтому
 * величина живёт у рандеву (`rendezvous.ts`), а не у входа в матч.
 */
export function slotCandidates(mode: DemoMode, players: readonly string[]): readonly string[] {
  return mode.kind === 'server' ? [...players] : players.slice(0, 1);
}

/**
 * URL страницы для подключения к стенду: та же страница, другой режим старта.
 * Адрес стенда по умолчанию выводится из САМОЙ ССЫЛКИ — то есть из страницы,
 * на которой стоит кнопка (`demoServerUrl`).
 */
export function serverModeUrl(href: string, url?: string): string {
  const target = new URL(href);
  target.searchParams.delete('solo');
  target.searchParams.set('server', url ?? demoServerUrl(target));
  return target.toString();
}

/** URL страницы дефолтного режима — матча против бота во вкладке. */
export function localModeUrl(href: string): string {
  const target = new URL(href);
  target.searchParams.delete('solo');
  target.searchParams.delete('server');
  return target.toString();
}
