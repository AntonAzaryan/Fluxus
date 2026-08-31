/**
 * Типы к `matchFile.mjs` — ради теста слоя запускалок (`test/matchFile.test.ts`)
 * и теста стенда демо (`game/demo-ts/test/demoStandRewind.test.ts`).
 *
 * Отдельным файлом, а не переписыванием бина на TypeScript, по той же причине,
 * что и `trace.d.mts`: `bin/` — слой командной строки, он исполняется `node`
 * напрямую и в tsconfig пакета не входит намеренно.
 *
 * Объявление здесь не украшение, а половина защиты от следующей потерянной
 * секции: `MATCH_DOCUMENT_FIELDS` и `LAUNCHER_FIELDS` объявлены КОРТЕЖАМИ
 * литералов, и тест сверяет их объединение с `keyof MatchConfig` типом. Поле,
 * добавленное в конфиг матча и не названное ни в одном из списков, краснеет на
 * `npm run typecheck` — до того, как молча пропадёт из матча.
 */
import type { SceneDef } from '@fluxus/core';
import type { LoadedContentPack } from '../src/content/pack.js';
import type { MatchConfig } from '../src/server/matchServer.js';

export declare const MATCH_DOCUMENT_FIELDS: readonly [
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
  'pause',
  'physics',
  'locomotion',
  'visibility',
  'navigation',
];

export declare const LAUNCHER_FIELDS: readonly [
  'version',
  'scene',
  'silenceTicks',
  'allowObserver',
  'observers',
  'trace',
  'rewindWarn',
  'eventVisibility',
];

/**
 * Поля документа, которые запускалка отдаёт КЛИЕНТУ (NTR-14): подмножество
 * `MATCH_DOCUMENT_FIELDS`, полнота которого проверяется типом в тестах.
 */
export declare const CLIENT_BUILD_FIELDS: readonly ['physics', 'visibility', 'navigation'];

/** Зависимости сборки мира для клиента — ровно объявленные документом секции. */
export declare function clientBuildOptions(
  match: MatchDocument,
): Partial<Pick<MatchConfig, (typeof CLIENT_BUILD_FIELDS)[number]>>;

/** Поле `MatchConfig`, которое документ матча везёт как есть. */
export type MatchDocumentField = (typeof MATCH_DOCUMENT_FIELDS)[number];

/** Поле `MatchConfig`, которое назначает сборка запуска, а не документ. */
export type LauncherField = (typeof LAUNCHER_FIELDS)[number];

/**
 * Документ матча: секции конфига, которые он везёт как есть, плюс четыре поля,
 * которые потребляет сама запускалка (контент-пак, `buildId`, порог молчания в
 * секундах и развёрнутые чтением сцены).
 *
 * Секции выведены из `MatchConfig`, а не переписаны рядом: вторая запись тех же
 * имён и есть способ им разойтись.
 */
export type MatchDocument = Partial<Pick<MatchConfig, MatchDocumentField>> & {
  readonly buildId?: string;
  /** Ссылка сцены → путь к её файлу, относительно файла матча. */
  readonly contentPack?: Readonly<Record<string, string>>;
  /** Развёрнутый контент-пак: заполняет `readMatchFile`, в документе его нет. */
  readonly scenes?: Readonly<Record<string, SceneDef>>;
  /** Порог молчания слота в секундах; конфиг матча считает его в тиках. */
  readonly silenceSeconds?: number;
};

export declare function readMatchFile(path: string): MatchDocument;
export declare function matchConfigOf(match: MatchDocument, pack: LoadedContentPack): MatchConfig;
export declare function matchDataOf(
  match: MatchDocument,
  pack: LoadedContentPack,
): Omit<MatchConfig, 'version' | 'players'>;
export declare function flag(name: string): boolean;
export declare function option(name: string, fallback: string): string;
export declare function option(name: string, fallback?: string): string | undefined;
