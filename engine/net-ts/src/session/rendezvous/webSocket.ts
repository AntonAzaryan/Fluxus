/**
 * Рандеву поверх WebSocket (`net-session` SES-3): оба канала сессии — лобби и
 * матч — живут на одном порту и различаются путём URL.
 *
 * Ограничение шага названо прямо: слушать входящие соединения умеет процесс, а
 * не вкладка браузера, поэтому хостом здесь бывает Node или десктопная сборка, а
 * участник за NAT доберётся до неё по LAN или пробросу порта. Продуктовый ответ
 * для веба — рандеву поверх WebRTC, и встанет оно сюда же: `publish` регистрирует
 * сессию у сигналинга, `resolve` проводит обмен параметрами соединения и отдаёт
 * `Transport` поверх DataChannel. Ни сервер, ни клиент, ни протокол этого не
 * заметят (SES-2).
 */
import { connectWebSocket } from '../../transport/webSocketClient.js';
import { webSocketChannelServer, type WebSocketChannelServer } from '../../transport/webSocketServer.js';
import type { Transport } from '../../transport/transport.js';
import { decodeInvite, encodeInvite } from '../invite.js';
import { randomToken } from './token.js';
import { RendezvousError, type PublishedSession, type Rendezvous, type SessionChannel } from '../rendezvous.js';

const VIA = 'ws';

export interface WebSocketRendezvousOptions {
  /** Сторона основателя: порт, на котором поднимать каналы. `0` — любой свободный. */
  readonly port?: number;
  readonly host?: string;
  /**
   * Адрес, который уедет в инвайт. Отличается от `host` там, где хост за
   * пробросом: слушает он `0.0.0.0`, а зовут его по внешнему имени.
   */
  readonly advertise?: string;
  /** Срок жизни инвайта, мс. Хост проверяет свой срок на входе в лобби (SES-5). */
  readonly inviteTtlMs?: number;
  readonly now?: () => number;
  readonly token?: () => string;
}

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Путь канала. Свойство рандеву, а не протокола: сервер и клиент матча его не видят. */
const PATHS: Record<SessionChannel, string> = { lobby: '/lobby', match: '/match' };

export class WebSocketRendezvous implements Rendezvous {
  readonly name = VIA;

  private readonly options: WebSocketRendezvousOptions;
  private servers: WebSocketChannelServer | undefined;

  constructor(options: WebSocketRendezvousOptions = {}) {
    this.options = options;
  }

  /** Порт, на котором поднялись каналы. До первого `publish` — `undefined`. */
  get port(): number | undefined {
    return this.servers?.port;
  }

  async publish(channel: SessionChannel): Promise<PublishedSession> {
    const servers = await this.ensureServers();
    const now = (this.options.now ?? Date.now)();
    const token = (this.options.token ?? randomToken)();
    const authority = this.options.advertise ?? `127.0.0.1:${servers.port}`;
    const invite = encodeInvite({
      via: VIA,
      channel,
      token,
      url: `ws://${authority}${PATHS[channel]}`,
      expiresAt: now + (this.options.inviteTtlMs ?? DEFAULT_TTL_MS),
    });
    const transports = servers.channel(PATHS[channel]);
    return {
      transports,
      invite,
      close: () => transports.close(),
    };
  }

  async resolve(invite: string): Promise<Transport> {
    const payload = decodeInvite(invite);
    if (payload.via !== VIA) throw new RendezvousError(`инвайт выдан другим рандеву: ${payload.via}`);
    if (payload.url === undefined) throw new RendezvousError('инвайт без адреса');
    // Срок проверяется и здесь, и хостом. Здесь — чтобы предъявитель узнал
    // раньше; нормативной остаётся проверка хоста (SES-5), потому что часы
    // предъявителя ему не подчиняются.
    const now = (this.options.now ?? Date.now)();
    if (payload.expiresAt !== undefined && payload.expiresAt <= now) {
      throw new RendezvousError('инвайт просрочен');
    }
    return connectWebSocket(payload.url);
  }

  /** Закрывает оба канала и порт. Публиковать после этого нельзя — сессия кончилась. */
  async close(): Promise<void> {
    const servers = this.servers;
    this.servers = undefined;
    if (servers !== undefined) await servers.close();
  }

  private async ensureServers(): Promise<WebSocketChannelServer> {
    if (this.servers !== undefined) return this.servers;
    if (this.options.port === undefined) {
      throw new RendezvousError('публиковать сессию без порта нельзя: это сторона присоединяющегося');
    }
    this.servers = await webSocketChannelServer({
      port: this.options.port,
      ...(this.options.host !== undefined ? { host: this.options.host } : {}),
    });
    return this.servers;
  }
}
