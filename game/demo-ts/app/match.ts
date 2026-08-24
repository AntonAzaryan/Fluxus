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
import type { SceneDef } from '@game-mvp/core';
import {
  contentPack,
  type LoadedContentPack,
  type MatchConfig,
  type MatchRewindOptions,
} from '@game-mvp/net';
// Раскладку документа матча в `MatchConfig` нормирует помощник запускалок
// (`@game-mvp/net/bin/matchFile.mjs`): остаток документа едет целиком,
// неизвестный ключ — отказ. Импортировать его сюда нельзя — он тянет `node:fs`
// и хук резолва, которых в сборке вкладки нет, — поэтому берутся его ТИПЫ:
// импорт стирается сборкой, а списки полей ниже приколочены типом кортежа.
import type { MATCH_DOCUMENT_FIELDS, MatchDocumentField } from '@game-mvp/net/bin/matchFile.mjs';
import sceneJson from '../../../content/scenes/duel.scene.json';
import matchJson from '../../../content/matches/duel.match.json';

/**
 * Поля `MatchConfig`, которые документ матча везёт КАК ЕСТЬ, — копия
 * `MATCH_DOCUMENT_FIELDS` запускалок, приколоченная ТИПОМ КОРТЕЖА: лишнее,
 * пропущенное или переставленное имя — красный `npm run typecheck`, а не молча
 * потерянная секция. Список нужен для ОТКАЗА (см. `matchFile.mjs`): ключ вне
 * него сервер матча не читает, и донести его до конфига молча значило бы
 * выдать опечатку за настройку. Ровно так поимённое перечисление здесь теряло
 * `teams`, `inputWindow` и `eventRepeat` — стенд их честно вёз, а вкладка
 * молча выбрасывала, и один документ поднимал два разных матча (NTR-14).
 */
export const DEMO_DOCUMENT_FIELDS: typeof MATCH_DOCUMENT_FIELDS = [
  'players',
  'seed',
  'sceneRef',
  'initial',
  'name',
  'teams',
  'tickRate',
  'snapshotRate',
  'inputDelay',
  'inputWindow',
  'eventRepeat',
  'rewind',
  'physics',
  'locomotion',
  'visibility',
];

/**
 * Поля документа, которые сборка потребляет САМА и в конфиг не передаёт
 * (`CONSUMED_BY_LAUNCHER` запускалок): `buildId` уезжает половиной версии
 * (NTR-5), контент-пак вкладка резолвит статическим импортом сцены, а порог
 * молчания документ считает в секундах, тогда как конфиг — в тиках.
 */
const DEMO_CONSUMED_FIELDS = ['buildId', 'contentPack', 'scenes', 'silenceSeconds'] as const;

/**
 * Документ матча (`netcode-transport` NTR-14): секции `MatchConfig`, которые
 * он везёт как есть, ВЫВЕДЕНЫ из типа раскладки запускалок, а не переписаны
 * рядом (вторая запись тех же имён и есть способ им разойтись), плюс поля,
 * которые сборка потребляет сама.
 */
interface DemoMatchDoc extends Partial<Pick<MatchConfig, MatchDocumentField>> {
  readonly name: string;
  readonly buildId: string;
  readonly seed: number;
  readonly players: readonly string[];
  readonly sceneRef: string;
  /** Ссылка сцены → путь к её файлу; вкладке не нужен — сцена импортирована статически. */
  readonly contentPack?: Readonly<Record<string, string>>;
  /** Порог молчания слота в секундах; конфиг матча считает его в тиках. */
  readonly silenceSeconds?: number;
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

/**
 * Тиков между шагами ведения точки перемотки (REW-13). Сервер делает шаг раз в
 * ЦИКЛ РАССЫЛКИ, то есть каждые `tickRate / snapshotRate` тиков; локальная
 * оболочка своей рассылки не имеет и берёт ту же величину отсюда.
 *
 * Выводится, а не берётся умолчанием оболочки: совпадение чисел — совпадение, а
 * не правило, и разойдись они, ульта отматывала бы на разную глубину за одно и
 * то же удержание в зависимости от того, кто произвёл тик (SHELL-8).
 */
export const DEMO_SCRUB_EVERY: number = Math.max(
  1,
  Math.round(DEMO_TICK_RATE / DEMO_SNAPSHOT_RATE),
);

export function demoScene(): SceneDef {
  return sceneJson as unknown as SceneDef;
}

/** Контент-пак клиента: сцену он резолвит локально, сервер её не раздаёт (NET-16). */
export function demoContentPack(): LoadedContentPack {
  return contentPack({ [DEMO_SCENE_REF]: demoScene() });
}

/**
 * Документ матча → `MatchConfig` — ТА ЖЕ раскладка, что у `matchConfigOf`
 * запускалок, и совпадение держит тест (`test/demoStandRewind.test.ts`): один
 * документ матча обязан поднимать один и тот же мир и во вкладке, и на
 * выделенном стенде, иначе хеш `worldInit` разойдётся ещё на входе (NTR-14,
 * NTR-5). Секции документа едут ЦЕЛИКОМ, остатком объекта, а не перечислением
 * имён (так вкладка молча теряла `teams`, `inputWindow` и `eventRepeat`);
 * неизвестный ключ — отказ, а не молча проглоченная опечатка. Выводятся только
 * поля, которых в документе нет буквально: версия, сцена и порог молчания в
 * тиках.
 */
export function demoMatchConfigOf(document: DemoMatchDoc, pack: LoadedContentPack): MatchConfig {
  const carried: Record<string, unknown> = { ...document };
  for (const field of DEMO_CONSUMED_FIELDS) delete carried[field];
  const unknown = Object.keys(carried).filter(
    (key) => !(DEMO_DOCUMENT_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `документ матча: ${unknown.map((key) => `"${key}"`).join(', ')} сервером матча не читается. ` +
        `Поля документа: ${[...DEMO_DOCUMENT_FIELDS, ...DEMO_CONSUMED_FIELDS].join(', ')}`,
    );
  }
  const scene = pack.scene(document.sceneRef);
  if (scene === undefined) {
    throw new Error(`документ матча: сцена "${document.sceneRef}" не входит в контент-пак`);
  }
  const tickRate = document.tickRate ?? 60;
  return {
    ...(carried as Pick<MatchConfig, MatchDocumentField>),
    // Версия матча (NET-16): сборка плюс хеш контент-пака, считаемый из своей сцены.
    version: { buildId: document.buildId, contentPackHash: pack.hash },
    scene,
    initial: document.initial ?? [],
    tickRate,
    snapshotRate: document.snapshotRate ?? 30,
    inputDelay: document.inputDelay ?? 2,
    silenceTicks: (document.silenceSeconds ?? 10) * tickRate,
  };
}

/**
 * Конфиг матча демо-арены. Зависимости сборки мира (NTR-14) едут из документа
 * матча, а не из умолчаний кода: сцена, рассчитанная на интегрирующую физику,
 * без них молча стояла бы на месте.
 */
export function demoMatchConfig(pack: LoadedContentPack = demoContentPack()): MatchConfig {
  return demoMatchConfigOf(doc, pack);
}
