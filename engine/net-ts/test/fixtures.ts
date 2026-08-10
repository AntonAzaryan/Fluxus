/**
 * Общие фикстуры сетевых тестов: сцена дуэли, конфиг матча и связка «сервер +
 * два клиента» на внутрипроцессном транспорте.
 *
 * Сцена повторяет golden-сценарий `input-drive` ядра — движение по вводу и
 * событие каста по фронту кнопки. Взята именно она, потому что проверка
 * парности (NTR-8) сравнивает сетевой прогон с прогоном ядра, и сцена, чьё
 * поведение уже зафиксировано эталоном, делает расхождение однозначным:
 * виноват сетевой слой, а не сомнительная сцена.
 */
import {
  contentPackHash,
  fixed,
  TEAM_SCHEMA,
  VISIBILITY_SCHEMA,
  type SceneDef,
} from '@game-mvp/core';
import { contentPack } from '../src/content/pack.js';
import { ClientHost, type ClientHostOptions } from '../src/client/host.js';
import { MatchClient, type MatchClientOptions } from '../src/client/matchClient.js';
import { MatchHost } from '../src/server/host.js';
import { MatchServer, type MatchConfig } from '../src/server/matchServer.js';
import { LoopbackHub } from '../src/transport/loopback.js';
import type { Transport } from '../src/transport/transport.js';
import type { ClientMessage, GameVersion, WireInput } from '../src/protocol/messages.js';

export const BUILD_ID = 'test-build-0001';

export function duelScene(): SceneDef {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
        },
      },
    ],
    systems: [
      {
        name: 'Movement',
        order: 10,
        query: { all: ['Position', 'Input'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: {
                x: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveX'] },
                  ],
                },
                y: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'y'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveY'] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    capacity: 8,
  };
}

/**
 * Та же сцена, но компоненты FoW объявлены СЦЕНОЙ РУКАМИ, а не флагом `fog`
 * (SER-7), и маску `Visibility` авторит расстановка либо JSON-система сцены.
 *
 * Нужна тестам, предмет которых — сетевой слой: `viewpoint` соединения и момент
 * отбора, а не расчёт видимости. Пересчёта такая сцена не требует и не получает —
 * отказ NTR-14 привязан к флагу `fog`, ровно тому признаку, по которому загрузчик
 * и так решает, дописывать ли компоненты тумана (решение 5 дизайна
 * `filter-ownership`), — поэтому нативная `VisibilitySystem` маску не
 * перезаписывает и тест остаётся про сеть.
 *
 * Матч на сцене с флагом `fog` — это `fogScene()` ниже, и он пересчёт объявляет.
 */
export function authoredMaskScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    components: [...scene.components, VISIBILITY_SCHEMA, TEAM_SCHEMA],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
          Visibility: { visibleTo: 0 },
          Team: { id: 0 },
        },
      },
    ],
  };
}

/**
 * Та же сцена с туманом: компоненты FoW добавляет загрузчик по флагу `fog`
 * (SER-7). Матч на ней ОБЯЗАН объявить пересчёт видимости (NTR-14), поэтому маску
 * считает нативная `VisibilitySystem`, а не держит расстановка.
 *
 * Расстановка при этом ставит те же значения, которые посчитает система:
 * наблюдателей с `Vision` в сцене нет, и маска сводится к биту собственной
 * команды сущности (FOW-3). Совпадение сделано намеренно — тесту сетевого слоя
 * нужен предсказуемый состав персонального снапшота, а не расчёт видимости (он
 * покрыт FOW-тестами ядра). Сцена, где маску авторит контент и пересчёта нет
 * вовсе, — `authoredMaskScene()` выше.
 */
export function fogScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
          Visibility: { visibleTo: 0 },
          Team: { id: 0 },
        },
      },
    ],
    fog: true,
  };
}

/**
 * Та же сцена с расстановкой в конфиге (SER-7, SER-8): реквизит стоит на арене
 * в каждом её прогоне, а герои приходят расстановкой конфига матча. Обе
 * расстановки складываются, сцена идёт первой — и ID выданы в этом порядке.
 */
export function placedScene(): SceneDef {
  const scene = duelScene();
  return {
    ...scene,
    prefabs: [...(scene.prefabs ?? []), { name: 'Prop', components: { Position: { x: 0, y: 0 } } }],
    initial: [
      { prefab: 'Prop', overrides: { Position: { x: fixed.fromInt(2), y: 0 } } },
      { prefab: 'Prop', overrides: { Position: { x: 0, y: fixed.fromInt(3) } } },
    ],
  };
}

export function versionOf(scene: SceneDef): GameVersion {
  return { buildId: BUILD_ID, contentPackHash: contentPackHash(scene) };
}

export function duelConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  const scene = overrides.scene ?? duelScene();
  return {
    version: versionOf(scene),
    players: ['p1', 'p2'],
    seed: 99,
    sceneRef: 'duel',
    scene,
    initial: [{ prefab: 'Hero' }, { prefab: 'Hero', overrides: { Player: { slot: 1 } } }],
    tickRate: 60,
    snapshotRate: 30,
    inputDelay: 2,
    ...overrides,
  };
}

/** Доставка в loopback асинхронная (NTR-2), поэтому шаг теста заканчивается тут. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface Clock {
  ms: number;
}

export interface ConnectedClient {
  readonly client: MatchClient;
  readonly host: ClientHost;
  /** Клиентский конец канала: нужен тестам, которые рвут связь со своей стороны. */
  readonly transport: Transport;
}

export function connectClient(
  hub: LoopbackHub,
  playerId: string,
  clock: Clock,
  scene: SceneDef,
  options: Partial<MatchClientOptions> & Pick<ClientHostOptions, 'input'> = {},
): ConnectedClient {
  const pack = contentPack({ duel: scene });
  const { input, ...clientOptions } = options;
  const client = new MatchClient({
    playerId,
    version: { buildId: BUILD_ID, contentPackHash: pack.hash },
    content: pack,
    ...clientOptions,
  });
  const transport = hub.connect();
  const host = new ClientHost(client, transport, {
    now: () => clock.ms,
    ...(input !== undefined ? { input } : {}),
  });
  host.start();
  return { client, host, transport };
}

export interface Harness {
  readonly hub: LoopbackHub;
  readonly server: MatchServer;
  readonly host: MatchHost;
  readonly clock: Clock;
}

export function harness(config: MatchConfig = duelConfig()): Harness {
  const hub = new LoopbackHub();
  const server = new MatchServer(config);
  return { hub, server, host: new MatchHost(server, hub), clock: { ms: 0 } };
}

// ------------------------------------------------------ сообщения для тестов,
// работающих с `MatchServer` напрямую, без транспорта (NTR-3)

export function hello(playerId: string, version: GameVersion, observer = false): ClientMessage {
  return { type: 'Hello', playerId, version, observer };
}

export function wireInput(tick: number, seq: number, moveX = 0, moveY = 0, buttons = 0): WireInput {
  return { tick, seq, moveX, moveY, aimDir: 0, buttons };
}

/** Эпоха — величина сообщения, а не кадра (NTR-16); матч без перемотки живёт нулевой. */
export function inputMessage(...frames: WireInput[]): ClientMessage {
  return { type: 'Input', epoch: 0, frames };
}

/** То же сообщение, но от клиента, уже пересинхронизировавшегося на новую эпоху. */
export function inputMessageOf(epoch: number, ...frames: WireInput[]): ClientMessage {
  return { type: 'Input', epoch, frames };
}

/** Один шаг вправо в Q16.16 — заметное движение, которое видно в снапшоте. */
export const STEP: number = fixed.fromInt(1);
