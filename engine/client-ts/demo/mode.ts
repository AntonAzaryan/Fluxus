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
 * Адрес стенда демо-арены — константа СБОРКИ (D4), а не поле UI: лобби, списка
 * серверов и авторизации у демо нет. `?server=ws://…` её переопределяет.
 */
export const DEMO_SERVER_URL = 'ws://127.0.0.1:8080';

export type DemoMode =
  /** Одиночная симуляция в воркере: прежняя сборка, пауза и перемотка (SHELL-8, `local`). */
  | { readonly kind: 'solo' }
  /** Матч против бота, поднятый прямо во вкладке (`net-session` SES-1, `local`). */
  | { readonly kind: 'local' }
  /** Выделенный стенд по адресу сборки либо из `?server=` (SES-1, `dedicated`). */
  | { readonly kind: 'server'; readonly url: string };

/** Режим из строки запроса страницы. Пустой `?server=` считается «адрес сборки». */
export function demoMode(search: string): DemoMode {
  const params = new URLSearchParams(search);
  if (params.has('solo')) return { kind: 'solo' };
  if (!params.has('server')) return { kind: 'local' };
  const url = params.get('server');
  return { kind: 'server', url: url === null || url === '' ? DEMO_SERVER_URL : url };
}

/**
 * Порядок попыток занять слот (D4): первый пришедший получает первый слот, а
 * получивший отказ пробует следующий. У матча, поднятого своей же вкладкой,
 * кандидат один — второй слот держит бот-заполнитель (BOT-7), и отбирать его у
 * себя незачем.
 */
export function slotCandidates(mode: DemoMode, players: readonly string[]): readonly string[] {
  return mode.kind === 'server' ? [...players] : players.slice(0, 1);
}

/** URL страницы для подключения к стенду: та же страница, другой режим старта. */
export function serverModeUrl(href: string, url: string = DEMO_SERVER_URL): string {
  const target = new URL(href);
  target.searchParams.delete('solo');
  target.searchParams.set('server', url);
  return target.toString();
}

/** URL страницы дефолтного режима — матча против бота во вкладке. */
export function localModeUrl(href: string): string {
  const target = new URL(href);
  target.searchParams.delete('solo');
  target.searchParams.delete('server');
  return target.toString();
}
