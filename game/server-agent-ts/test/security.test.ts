/**
 * Безопасность управляющего канала (SRV-3, решение D4): TLS, TOFU-пиннинг
 * отпечатка, пейринг кодом и отзыв токена.
 *
 * Каждое утверждение требования здесь — свой тест: сертификат переиспользуется
 * между стартами (иначе пиннинг кричал бы на штатный рестарт), операция без
 * токена — отказ, отозванный токен перестаёт действовать И для существующего
 * подключения, а смена отпечатка известного хоста — ГРОМКИЙ отказ клиентской
 * библиотеки, а не тихое переподключение.
 */
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureCertificate, fingerprintOf } from '../src/state/certificate.js';
import { agentPaths } from '../src/state/paths.js';
import { tokenStore, MAX_PAIRING_FAILURES, PAIRING_CODE_TTL_MS } from '../src/state/tokens.js';
import { createControlClient, type ControlClient } from '../src/client/index.js';
import { nodeSocket } from '../src/client/node.js';
import type { Agent } from '../src/agent.js';
import { fakeAgent, sandbox, until, type Sandbox } from './support.js';

const boxes: Sandbox[] = [];
const agents: Agent[] = [];
const clients: ControlClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const agent of agents.splice(0)) await agent.close();
  for (const box of boxes.splice(0)) box.drop();
});

function box(): Sandbox {
  const created = sandbox();
  boxes.push(created);
  return created;
}

describe('сертификат агента (SRV-3, решение D4)', () => {
  it('повторный старт переиспользует сертификат: отпечаток не меняется', () => {
    const paths = agentPaths(box().stateDir);
    const first = ensureCertificate(paths);
    const second = ensureCertificate(paths);
    // Иначе закреплённый клиентом отпечаток менялся бы на каждый рестарт
    // агента, и «громкий отказ при смене» кричал бы на штатный перезапуск.
    expect(second.cert).toBe(first.cert);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(readFileSync(paths.certFile, 'utf8'))).toBe(first.fingerprint);
  });

  it('канал существует только шифрованным: по http эндпоинт не отвечает', async () => {
    const agent = await fakeAgent(box());
    agents.push(agent);
    // Незашифрованного варианта нет ни в какой конфигурации (SRV-3): попытка
    // говорить с ним открытым текстом не даёт ни сессии, ни ответа.
    const plain = createControlClient(nodeSocket);
    clients.push(plain);
    await expect(
      plain.connect({ url: agent.controlUrl.replace('wss://', 'ws://') }),
    ).rejects.toMatchObject({ reason: 'connect-failed' });
  });
});

describe('пейринг и токены (SRV-3)', () => {
  it('код обменивается на токен, дальше подключение идёт без кода', async () => {
    const agent = await fakeAgent(box());
    agents.push(agent);
    const code = agent.tokens.issueCode(Date.now());

    const first = createControlClient(nodeSocket);
    clients.push(first);
    const paired = await first.connect({ url: agent.controlUrl, pairingCode: code, label: 'менеджер' });
    expect(paired.token).not.toBe('');

    const again = createControlClient(nodeSocket);
    clients.push(again);
    const returning = await again.connect({ url: agent.controlUrl, token: paired.token });
    // Токен уезжает РОВНО ОДИН раз — в ответ на пейринг.
    expect(returning.token).toBe('');
    expect((await again.list()).servers).toEqual([]);
  });

  it('операция без токена — отказ, и код одноразовый', async () => {
    const agent = await fakeAgent(box());
    agents.push(agent);
    const bare = createControlClient(nodeSocket);
    clients.push(bare);
    await expect(bare.connect({ url: agent.controlUrl })).rejects.toMatchObject({
      reason: 'unauthorized',
    });

    const code = agent.tokens.issueCode(Date.now());
    const one = createControlClient(nodeSocket);
    clients.push(one);
    await one.connect({ url: agent.controlUrl, pairingCode: code });
    // Тот же код второй раз не пройдёт: подслушавший его не получит токен на
    // тех же основаниях.
    const two = createControlClient(nodeSocket);
    clients.push(two);
    await expect(two.connect({ url: agent.controlUrl, pairingCode: code })).rejects.toMatchObject({
      reason: 'pairing-failed',
    });
  });

  it('просроченный код не действует (SRV-3: код короткоживущий)', () => {
    const paths = agentPaths(box().stateDir);
    const store = tokenStore(paths.tokensFile);
    const code = store.issueCode(0);
    expect(store.redeem(code, 'поздно', PAIRING_CODE_TTL_MS + 1)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('код — не шесть цифр: перебором его в окне не взять (SRV-3)', () => {
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const code = store.issueCode(Date.now());
    // Расширенный алфавит и длина: пространство кода на порядки больше прежних
    // миллиона шестизначных.
    expect(code).toMatch(/^[0-9A-Z]{10}$/);
  });

  it('перебор кода запирает пейринг — даже верный код после порога не проходит', () => {
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    const good = store.issueCode(now);
    // N неверных попыток подряд: канал слушает наружу, и молотить его можно без
    // предела — порог закрывает саму возможность.
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) {
      expect(store.redeem('НЕВЕРНЫЙ00', 'взлом', now)).toBeUndefined();
    }
    expect(store.pairingLocked(now)).toBe(true);
    // Верный код, оставшийся на руках, тоже отвергается: иначе порог не защищал
    // бы — угадавший с (N+1)-й попытки всё равно прошёл бы.
    expect(store.redeem(good, 'взлом', now)).toBeUndefined();
    // Окно проходит — пейринг снова открыт.
    expect(store.pairingLocked(now + PAIRING_CODE_TTL_MS + 1)).toBe(false);
  });

  it('ротация кода запирание НЕ снимает: у машины при ней никто не стоит', () => {
    // Адресный файл автопейринга (MGR-5) обновляется, пока агент жив, — то есть
    // выдача кода случается и БЕЗ человека у машины. Сбрасывай она счётчик
    // перебора, порог `MAX_PAIRING_FAILURES` жил бы не дольше периода ротации, и
    // молотить канал (SRV-3) можно было бы без предела, дожидаясь очередной.
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    for (let i = 0; i < MAX_PAIRING_FAILURES; i++) store.redeem('НЕВЕРНЫЙ00', 'взлом', now);
    expect(store.pairingLocked(now)).toBe(true);

    const rotated = store.mintCode(now);
    expect(rotated).toMatch(/^[0-9A-Z]{10}$/);
    expect(store.pairingLocked(now)).toBe(true);
    // И код, выданный ротацией, запертым пейрингом не обменивается — как всякий
    // другой: порог отказывает даже верному коду.
    expect(store.redeem(rotated, 'взлом', now)).toBeUndefined();

    // Локальная команда человека у машины по-прежнему открывает пейринг: это и
    // есть та единственная дверь, ради которой сброс заведён.
    const local = store.issueCode(now);
    expect(store.pairingLocked(now)).toBe(false);
    expect(store.redeem(local, 'свой', now)).not.toBeUndefined();
  });

  it('повторное предъявление СВОЕГО обменянного кода пейринг не запирает', () => {
    // Адресный файл автопейринга держит один код на период ротации (MGR-5), а
    // локальная сессия менеджера токена не хранит и пейрится кодом каждый раз
    // (`session.addLocal`). Значит, сессии, поднятые в одном окне, предъявляют
    // ОДИН И ТОТ ЖЕ код: первая его обменивает, остальные предъявляют уже
    // обменянный. Считай агент это перебором — полудюжина быстрых запусков
    // менеджера запирала бы пейринг на TTL, и снять запрет мог бы только человек
    // у машины. Токена повтор при этом по-прежнему не даёт (SRV-3).
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    const code = store.mintCode(now);
    expect(store.redeem(code, 'первая сессия', now)).not.toBeUndefined();

    for (let i = 0; i < MAX_PAIRING_FAILURES + 2; i++) {
      expect(store.redeem(code, 'вторая сессия', now + i)).toBeUndefined();
    }
    expect(store.pairingLocked(now + 10)).toBe(false);
    // И следующая ротация по-прежнему обменивается: пейринг остался открыт.
    const next = store.mintCode(now + 60_000);
    expect(store.redeem(next, 'следующий запуск', now + 60_001)).not.toBeUndefined();
  });

  it('обменянный код НЕ воскресает: помеченная запись токена больше не даёт', () => {
    // Отметка `usedAt` заведена ради счётчика попыток, а не ради послаблений:
    // одноразовость кода (SRV-3) от неё не меняется — подслушавший его второго
    // токена не получит.
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    const code = store.issueCode(now);
    expect(store.redeem(code, 'свой', now)).not.toBeUndefined();
    expect(store.redeem(code, 'подслушавший', now + 1)).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it('код, выданный прошлой ротацией, живёт свой TTL: страница читает файл заранее', () => {
    // Ротация прежний код не гасит намеренно: адресный файл читают один раз, а
    // предъявляют позже (MGR-5, DSK-7). Погаси она предыдущий — прочитанный за
    // секунду до неё код умирал бы в руках у страницы, и автопейринг отказывал
    // бы без всякой причины.
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    const first = store.mintCode(now);
    const second = store.mintCode(now + 60_000);
    expect(second).not.toBe(first);
    expect(store.redeem(first, 'страница', now + 60_001)).not.toBeUndefined();
    // Своё окно он при этом не переживает: код остаётся короткоживущим (SRV-3).
    expect(store.redeem(second, 'поздно', now + 60_000 + PAIRING_CODE_TTL_MS + 1)).toBeUndefined();
  });

  it('успешный пейринг снимает запирание: за пультом свой человек', () => {
    const store = tokenStore(agentPaths(box().stateDir).tokensFile);
    const now = Date.now();
    for (let i = 0; i < MAX_PAIRING_FAILURES - 1; i++) store.redeem('НЕВЕРНЫЙ00', 'x', now);
    const good = store.issueCode(now);
    expect(store.redeem(good, 'свой', now)).not.toBeUndefined();
    expect(store.pairingLocked(now)).toBe(false);
  });

  it('отзыв токена рвёт живое подключение и закрывает вход по нему', async () => {
    const agent = await fakeAgent(box());
    agents.push(agent);
    const code = agent.tokens.issueCode(Date.now());
    const client = createControlClient(nodeSocket);
    clients.push(client);
    const paired = await client.connect({ url: agent.controlUrl, pairingCode: code, label: 'уходящий' });

    const listed = (await client.tokens()).tokens;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.label).toBe('уходящий');

    await client.revoke(listed[0]!.id);
    // Отозванный токен перестаёт действовать для СУЩЕСТВУЮЩЕГО подключения:
    // канал закрывается, а не доживает до следующей операции.
    await until(() => !client.connected);
    expect(client.connected).toBe(false);

    const denied = createControlClient(nodeSocket);
    clients.push(denied);
    await expect(denied.connect({ url: agent.controlUrl, token: paired.token })).rejects.toMatchObject({
      reason: 'unauthorized',
    });
  });
});

describe('TOFU-пиннинг отпечатка (SRV-3)', () => {
  it('смена отпечатка известного хоста — громкий отказ клиентской библиотеки', async () => {
    const current = box();
    const first = await fakeAgent(current);
    agents.push(first);
    const code = first.tokens.issueCode(Date.now());
    const client = createControlClient(nodeSocket);
    clients.push(client);
    const paired = await client.connect({ url: first.controlUrl, pairingCode: code });
    const pinned = paired.fingerprint;
    expect(pinned).toBe(first.certificate.fingerprint);
    client.close();
    await first.close();
    agents.pop();

    // Хост предъявляет ДРУГОЙ сертификат: так выглядит и подмена, и переезд
    // агента на новый ключ. Различить их машина не может — решает человек.
    const paths = agentPaths(current.stateDir);
    rmSync(paths.keyFile, { force: true });
    rmSync(paths.certFile, { force: true });
    const second = await fakeAgent(current);
    agents.push(second);
    expect(second.certificate.fingerprint).not.toBe(pinned);

    const returning = createControlClient(nodeSocket);
    clients.push(returning);
    await expect(
      returning.connect({ url: second.controlUrl, token: paired.token, pinned }),
    ).rejects.toMatchObject({ reason: 'fingerprint-changed' });

    // И это ОТКАЗ, а не переподключение: продолжить можно только явным
    // решением человека — новым закреплением отпечатка.
    const deliberate = createControlClient(nodeSocket);
    clients.push(deliberate);
    const code2 = second.tokens.issueCode(Date.now());
    const accepted = await deliberate.connect({ url: second.controlUrl, pairingCode: code2 });
    expect(accepted.fingerprint).toBe(second.certificate.fingerprint);
  });
});
