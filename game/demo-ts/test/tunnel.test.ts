/**
 * Туннель наружу (`app/tunnel.ts`): разбор адреса quick-туннеля из вывода
 * cloudflared, ссылка второму игроку и аргументы спавна. Проверяются ЧИСТЫЕ
 * половины — то единственное место, где сборка выбирает за человека, — без
 * спавна процесса: cloudflared в гейте не нужен, как Blender не нужен
 * импортёру (тот же принцип, что BLND-7).
 */
import { describe, expect, it } from 'vitest';
import { quickTunnelUrl, STAND_PROXY_PATH, tunnelArgs, tunnelShareLink } from '../app/tunnel.js';
import { demoMode } from '../app/mode.js';

describe('адрес quick-туннеля из вывода cloudflared', () => {
  it('находится в строке баннера', () => {
    const line =
      '2026-08-30T10:00:00Z INF |  https://lazy-otters-example.trycloudflare.com                                 |';
    expect(quickTunnelUrl(line)).toBe('https://lazy-otters-example.trycloudflare.com');
  });

  it('находится в ленте, куда адрес приехал двумя кусками', () => {
    // Потоки процесса режут вывод произвольно: проверка строки, а не ленты,
    // теряла бы адрес, разрезанный границей chunk'а.
    const first = 'INF |  https://lazy-ot';
    const second = 'ters-example.trycloudflare.com  |';
    expect(quickTunnelUrl(first)).toBeNull();
    expect(quickTunnelUrl(first + second)).toBe('https://lazy-otters-example.trycloudflare.com');
  });

  it('не выдумывается из постороннего вывода', () => {
    expect(quickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(quickTunnelUrl('https://developers.cloudflare.com/downloads')).toBeNull();
    expect(quickTunnelUrl('')).toBeNull();
  });
});

describe('ссылка второму игроку', () => {
  it('приводит гостя на стенд хоста через режим страницы', () => {
    // Контракт ссылки — не её текст, а то, как её прочтёт страница (`mode.ts`):
    // явный `?server=` обязан дать сетевой режим с wss-адресом прокси-пути
    // стенда на ТОМ ЖЕ хосте — снаружи у туннеля открыт один порт.
    const link = new URL(tunnelShareLink('https://lazy-otters-example.trycloudflare.com'));
    const mode = demoMode(link.search, { protocol: link.protocol, hostname: link.hostname });
    expect(mode).toEqual({
      kind: 'server',
      url: `wss://lazy-otters-example.trycloudflare.com${STAND_PROXY_PATH}`,
    });
  });
});

describe('аргументы спавна cloudflared', () => {
  it('туннелят порт страницы и запрещают самообновление', () => {
    const args = tunnelArgs(5173);
    expect(args).toContain('http://127.0.0.1:5173');
    // Процесс, живущий рядом с матчем, не должен посреди него перекачивать
    // сам себя.
    expect(args).toContain('--no-autoupdate');
  });
});
