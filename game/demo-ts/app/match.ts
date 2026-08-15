/**
 * Матч демо-арены как данные: тот же `content/matches/duel.match.json` и та же
 * сцена, которыми играет выделенный стенд (`bin/demo-serve.mjs`).
 *
 * Общий модуль на обе половины сборки — сервер во вкладке и клиента, — потому
 * что расхождение здесь не отлаживается: разошёлся конфиг сборки мира (NTR-14),
 * и клиента не пускают в матч по несовпавшему хешу `worldInit` (NTR-5). Один
 * источник — один хеш.
 *
 * Контентом этот модуль не является (`game-content` CONT-1): контент лежит в
 * `content/`, здесь только его чтение и раскладка в `MatchConfig`.
 */
import type { PhysicsOptions, SceneDef, VisibilityOptions } from '@game-mvp/core';
import {
  contentPack,
  type LoadedContentPack,
  type MatchConfig,
  type MatchRewindOptions,
} from '@game-mvp/net';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

/** Документ матча (`netcode-transport` NTR-14) в объёме, который читает эта сборка. */
interface DemoMatchDoc {
  readonly name: string;
  readonly buildId: string;
  readonly seed: number;
  readonly players: readonly string[];
  readonly sceneRef: string;
  readonly initial?: MatchConfig['initial'];
  readonly physics?: PhysicsOptions;
  readonly locomotion?: MatchConfig['locomotion'];
  readonly visibility?: VisibilityOptions;
  readonly tickRate?: number;
  readonly snapshotRate?: number;
  readonly inputDelay?: number;
  readonly silenceSeconds?: number;
  readonly rewind?: MatchRewindOptions;
}

const doc = matchJson as unknown as DemoMatchDoc;

export const DEMO_MATCH: DemoMatchDoc = doc;
export const DEMO_PLAYERS: readonly string[] = doc.players;
export const DEMO_SCENE_REF = doc.sceneRef;
export const DEMO_TICK_RATE = doc.tickRate ?? 60;
export const DEMO_SNAPSHOT_RATE = doc.snapshotRate ?? 30;
/**
 * Настройки перемотки матча (NET-11): глубина буфера, cooldown вне отката и
 * орган ведения скраба. Читаются из документа матча обеими сборками демо —
 * сетевой и локальной (`worker.ts`): профиль истории и номер бита обязаны
 * совпасть, иначе ульта в одной сборке отматывает не туда, а в другой не
 * отматывает вовсе.
 */
export const DEMO_REWIND: MatchRewindOptions | undefined = doc.rewind;

export function demoScene(): SceneDef {
  return sceneJson as unknown as SceneDef;
}

/** Контент-пак клиента: сцену он резолвит локально, сервер её не раздаёт (NET-16). */
export function demoContentPack(): LoadedContentPack {
  return contentPack({ [DEMO_SCENE_REF]: demoScene() });
}

/** Версия матча (NET-16): сборка плюс хеш контент-пака, считаемый из своей сцены. */
export function demoVersion(pack: LoadedContentPack): { buildId: string; contentPackHash: string } {
  return { buildId: doc.buildId, contentPackHash: pack.hash };
}

/**
 * Конфиг матча демо-арены. Зависимости сборки мира (NTR-14) едут из документа
 * матча, а не из умолчаний кода: сцена, рассчитанная на интегрирующую физику,
 * без них молча стояла бы на месте.
 */
export function demoMatchConfig(pack: LoadedContentPack = demoContentPack()): MatchConfig {
  return {
    version: demoVersion(pack),
    players: doc.players,
    seed: doc.seed,
    sceneRef: DEMO_SCENE_REF,
    scene: demoScene(),
    initial: doc.initial ?? [],
    name: doc.name,
    tickRate: DEMO_TICK_RATE,
    snapshotRate: DEMO_SNAPSHOT_RATE,
    inputDelay: doc.inputDelay ?? 2,
    silenceTicks: (doc.silenceSeconds ?? 10) * DEMO_TICK_RATE,
    ...(doc.physics !== undefined ? { physics: doc.physics } : {}),
    ...(doc.locomotion !== undefined ? { locomotion: doc.locomotion } : {}),
    ...(doc.visibility !== undefined ? { visibility: doc.visibility } : {}),
    ...(doc.rewind !== undefined ? { rewind: doc.rewind } : {}),
  };
}
