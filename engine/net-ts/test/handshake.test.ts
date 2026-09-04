/**
 * Хендшейк (NTR-5): две сверки, которые до этого change'а были механизмами без
 * точки применения — пара версии (NET-16) и хеш `worldInit` (DET-1).
 *
 * Ключевое здесь — что исходы разные. «Версия устарела» и «разошлись данные
 * матча» лечатся по-разному: первое обновлением, второе разбирательством с
 * ассетами, — и слитый исход отправил бы игрока чинить не то.
 */
import { describe, expect, it } from 'vitest';
import { fixed } from '@fluxus/core';
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
import { MatchClient } from '../src/client/matchClient.js';
import { contentPack } from '../src/content/pack.js';
import { NO_SLOT, parseServerMessage } from '../src/protocol/messages.js';
import type { RejectMessage, WelcomeMessage, WireSnapshot } from '../src/protocol/messages.js';

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
    // Состав сообщения перечислен требованием поимённо (NTR-5) и закрыт:
    // «свободных полей на будущее … MUST NOT быть» (NTR-4).
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p2', config.version));

    const message = server.drain()[0]!.message as WelcomeMessage;
    expect(message.type).toBe('Welcome');
    expect(message.slot).toBe(1);
    expect(message.players).toEqual(['p1', 'p2']);
    expect(message.worldInitHash).toBe(server.worldInitHash);
    expect(message.pacing).toEqual({
      tickRate: 60,
      snapshotRate: 30,
      inputDelay: 2,
      inputWindow: 15,
      eventRepeat: 2,
    });
    // Сцена названа ссылкой: раздавать контент-пак матча сервер не должен (NET-16).
    expect(message.match.sceneRef).toBe('duel');
    expect(JSON.stringify(message)).not.toContain('components');
  });

  /**
   * `seed` на провод не едет (SES-4): клиент `tick()` не исполняет (NTR-10),
   * стартовый мир поднимает с нулём, и контрольная сумма `worldInit` от seed'а
   * не зависит вовсе. Поле, которого никто не читает, — то самое «свободное
   * поле на будущее», которого NTR-4 не допускает.
   */
  it('seed на провод не едет: его нет ни в отправленном сообщении, ни в разобранном (NTR-5, SES-4)', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p2', config.version));

    const message = server.drain()[0]!.message as WelcomeMessage;
    expect(message).not.toHaveProperty('seed');
    // Разбор на клиенте поле тоже не заводит — даже если оно приехало.
    const parsed = parseServerMessage({ ...(message as object), seed: 99 });
    expect(parsed).not.toHaveProperty('seed');
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
    // Сверка завершилась ДО первого действия самого клиента (NTR-5): ни одного
    // кадра ввода он не отправил и ни одного снапшота не применил. Матч при
    // этом мог бы уже идти — сервер подтверждения не ждёт и ждать ему нечем
    // (NTR-4); здесь он стоит в лобби просто потому, что второй слот пуст.
    expect(client.metrics.inputsSent).toBe(0);
    expect(client.latest).toBeUndefined();
    expect(server.phase).toBe('lobby');
    expect(server.tick).toBe(0);
  });

  it('снапшот прежде Welcome рвёт соединение ошибкой протокола, а не обходит сверку (NTR-5)', () => {
    // Сверять пришедшее состояние не с чем: своего `worldInit` у клиента ещё
    // нет, и применить снапшот значило бы нарисовать мир, тождественность
    // которого никто не проверял.
    const scene = duelScene();
    const client = new MatchClient({
      playerId: 'p1',
      version: versionOf(scene),
      content: contentPack({ duel: scene }),
    });

    // Содержимое кадра здесь роли не играет: до `Welcome` он не разбирается
    // вовсе — разбирать его нечем.
    const snapshot = { tick: 1, world: {}, events: [], mode: 'Running' } as unknown as WireSnapshot;
    client.receive({ type: 'Snapshot', epoch: 0, tick: 1, snapshot }, 0);

    expect(client.phase).toBe('closed');
    expect(client.closeReason).toBe('protocol-error');
    expect(client.closeDetail).toContain('Welcome');
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

  it('Start, обогнавший Welcome на неупорядоченном канале, не возвращает клиента в лобби (NTR-2)', () => {
    // Последнему вошедшему `Welcome` и `Start` уходят одной рассылкой, а
    // порядок доставки канал не гарантирует (NTR-2). Клиент, увидевший `Start`
    // первым, уже в игре — приветствие вслед не должно возвращать его в лобби,
    // где он до конца матча молча применял бы снапшоты и не слал ввод.
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    const toSecond = server.drain().filter((out) => out.to === 2).map((out) => out.message);
    expect(toSecond.map((message) => message.type)).toEqual(['Welcome', 'Start']);

    const scene = duelScene();
    const pack = contentPack({ duel: scene });
    const client = new MatchClient({
      playerId: 'p2',
      version: { buildId: BUILD_ID, contentPackHash: pack.hash },
      content: pack,
    });
    client.start();
    client.receive(toSecond[1]!, 0);
    client.receive(toSecond[0]!, 0);

    expect(client.phase).toBe('playing');
    expect(client.slot).toBe(1);
    // Запас разметки заведён приветствием, и ввод уходит.
    client.pushInput({ move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 }, 0);
    expect(client.drain().some((message) => message.type === 'Input')).toBe(true);
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

  it('с разрешением получает приветствие с сентинелем и игрового слота не занимает (NTR-21)', () => {
    const config = duelConfig({ allowObserver: true });
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('spectator', config.version, true));
    // Приветствие то же и того же состава (NTR-5): без него наблюдателю не из
    // чего поднять мир. Слота в нём нет — сентинель (NTR-21).
    const outgoing = server.drain();
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.message).toMatchObject({
      type: 'Welcome',
      slot: NO_SLOT,
      players: config.players,
    });
    // Матч по-прежнему в лобби: слоты наблюдатель не занимает, и `Start` он
    // дождётся вместе со всеми.
    expect(server.phase).toBe('lobby');
    expect(server.slotLease(0).claimed).toBe(false);
    expect(server.slotLease(1).claimed).toBe(false);
  });
});
