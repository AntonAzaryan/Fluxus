/**
 * Хендшейк (NTR-5): две сверки, которые до этого change'а были механизмами без
 * точки применения — пара версии (NET-16) и хеш `worldInit` (DET-1).
 *
 * Ключевое здесь — что исходы разные. «Версия устарела» и «разошлись данные
 * матча» лечатся по-разному: первое обновлением, второе разбирательством с
 * ассетами, — и слитый исход отправил бы игрока чинить не то.
 */
import { describe, expect, it } from 'vitest';
import { fixed } from '@game-mvp/core';
import {
  BUILD_ID,
  connectClient,
  duelConfig,
  duelScene,
  harness,
  hello,
  settle,
  versionOf,
} from './fixtures.js';
import type { RejectMessage, WelcomeMessage } from '../src/protocol/messages.js';

describe('сверка версии (NET-16)', () => {
  it('расхождение сборки отклоняет вход и называет половину', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', { ...config.version, buildId: 'other-build' }));

    const out = server.drain();
    expect(out).toHaveLength(1);
    const message = out[0]!.message as RejectMessage;
    expect(message.type).toBe('Reject');
    expect(message.reason).toBe('build-mismatch');
    expect(message.detail).toContain(BUILD_ID);
    expect(out[0]!.closeAfter).toBe(true);
  });

  it('расхождение контент-пака отклоняет вход отдельным исходом', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', { ...config.version, contentPackHash: '00000000' }));

    expect(server.drain()[0]!.message).toMatchObject({ type: 'Reject', reason: 'content-mismatch' });
  });

  it('отклонённый не узнаёт о матче ничего', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', { ...config.version, buildId: 'other-build' }));

    const out = server.drain();
    // Ни состава игроков, ни seed, ни хеша worldInit: сверка идёт ДО того, как
    // о матче сообщено что-либо (NTR-5).
    expect(out.every((entry) => entry.message.type === 'Reject')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('worldInitHash');
  });

  it('изменение одной JSON-системы меняет хеш контент-пака', () => {
    const base = duelScene();
    // Та же сцена с другим порядком исполнения системы — другие правила (NET-17).
    const patched = { ...base, systems: [{ ...base.systems![0]!, order: 11 }] };
    expect(versionOf(patched).contentPackHash).not.toBe(versionOf(base).contentPackHash);
  });

  it('незаявленный игрок и занятый слот — разные исходы', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p3', config.version));
    expect(server.drain()[0]!.message).toMatchObject({ reason: 'unknown-player' });

    server.connect(2);
    server.receive(2, hello('p1', config.version));
    server.drain();
    server.connect(3);
    server.receive(3, hello('p1', config.version));
    expect(server.drain()[0]!.message).toMatchObject({ reason: 'slot-taken' });
  });
});

describe('Welcome', () => {
  it('несёт слот, состав, хеш worldInit и темп — но не содержимое сцены', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p2', config.version));

    const message = server.drain()[0]!.message as WelcomeMessage;
    expect(message.type).toBe('Welcome');
    expect(message.slot).toBe(1);
    expect(message.players).toEqual(['p1', 'p2']);
    expect(message.worldInitHash).toBe(server.worldInitHash);
    expect(message.pacing).toEqual({ tickRate: 60, snapshotRate: 30, inputDelay: 2 });
    // Сцена названа ссылкой: раздавать контент-пак матча сервер не должен (NET-16).
    expect(message.match.sceneRef).toBe('duel');
    expect(JSON.stringify(message)).not.toContain('components');
  });
});

describe('сверка данных матча (DET-1)', () => {
  it('версии совпали, ассеты арены разошлись — вход рвётся клиентом', async () => {
    // Арена в хеш контент-пака НЕ входит (NET-17), поэтому версии тождественны;
    // в хеш `worldInit` входит (DET-1), поэтому расхождение обязано вскрыться.
    const serverScene = { ...duelScene(), arena: { center: { x: 0, y: 0 }, radius: fixed.fromInt(20) } };
    const clientScene = {
      ...duelScene(),
      arena: { center: { x: fixed.fromInt(5), y: 0 }, radius: fixed.fromInt(20) },
    };
    expect(versionOf(clientScene).contentPackHash).toBe(versionOf(serverScene).contentPackHash);

    const { hub, server, clock } = harness(duelConfig({ scene: serverScene }));
    const { client } = connectClient(hub, 'p1', clock, clientScene);
    await settle();

    expect(client.phase).toBe('closed');
    expect(client.closeReason).toBe('data-mismatch');
    expect(client.closeDetail).toContain(server.worldInitHash);
    // До первого тика матча дело не дошло: слот занят не был, матч не стартовал.
    expect(server.phase).toBe('lobby');
    expect(server.tick).toBe(0);
  });

  it('неизвестная клиенту сцена даёт тот же исход, и сцена ему не досылается', async () => {
    const { hub, clock } = harness(duelConfig({ sceneRef: 'unknown-arena' }));
    const { client } = connectClient(hub, 'p1', clock, duelScene());
    await settle();

    expect(client.phase).toBe('closed');
    expect(client.closeReason).toBe('data-mismatch');
    expect(client.closeDetail).toContain('unknown-arena');
  });

  it('совпавшие версия и хеш пускают клиента в лобби', async () => {
    const { hub, clock } = harness();
    const { client } = connectClient(hub, 'p1', clock, duelScene());
    await settle();

    expect(client.phase).toBe('lobby');
    expect(client.slot).toBe(0);
    expect(client.worldInitHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('наблюдатель (NTR-9)', () => {
  it('без разрешения сервера отклоняется', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('spectator', config.version, true));
    expect(server.drain()[0]!.message).toMatchObject({ reason: 'observer-not-allowed' });
  });

  it('с разрешением подключается и игрового слота не занимает', () => {
    const config = duelConfig({ allowObserver: true });
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('spectator', config.version, true));
    // Ни Welcome со слотом, ни Reject: наблюдатель ждёт Start вместе со всеми.
    expect(server.drain()).toHaveLength(0);
    expect(server.phase).toBe('lobby');
  });
});
