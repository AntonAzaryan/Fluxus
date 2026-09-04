/**
 * Матч демо-арены как данные: тот же `content/matches/duel.match.json` и та же
 * сцена, которыми играет выделенный стенд (`bin/demo-serve.mjs`).
 *
 * Документы ЧИТАЮТСЯ ИЗ РАЗДАЧИ, а не запекаются в сборку (`game-content`
 * CONT-5): их байты приезжают тем же адресным пространством и тем же источником,
 * что ассеты (`assets` ASSET-2), — константой сборки остаётся только АДРЕС
 * документа матча (`DEMO_MATCH_ID`). Версию игры (NET-16) страница выводит из
 * прочитанного тем же вычислением, что и сервер (NET-17), поэтому правка дерева,
 * которое раздаёт оболочка, доезжает до страницы сама, а рукопожатие (NTR-5)
 * сходится по построению, а не по совпадению сборок. Запечённый `import`ом
 * документ был бы второй копией документа дерева (CONT-3), и расхождение с ним
 * наблюдалось бы отказом входа по хешу контент-пака, а не сообщением о причине.
 *
 * Общий модуль на обе половины сборки — сервер во вкладке и клиента, — потому
 * что расхождение здесь не отлаживается: разошёлся конфиг сборки мира (NTR-14),
 * и клиента не пускают в матч по несовпавшему хешу `worldInit` (NTR-5). Один
 * источник — один хеш.
 *
 * Контентом этот модуль не является (`game-content` CONT-1): контент лежит в
 * `content/`, здесь только его чтение и раскладка в `MatchConfig`.
 */
import type { NavigationOptions, SceneDef } from '@fluxus/core';
import type { AssetSource } from '@fluxus/assets';
import {
  contentPack,
  type LoadedContentPack,
  type MatchConfig,
  type MatchRewindOptions,
} from '@fluxus/net';
// Раскладку документа матча в `MatchConfig` нормирует помощник запускалок
// (`@fluxus/net/bin/matchFile.mjs`): остаток документа едет целиком,
// неизвестный ключ — отказ. Импортировать его сюда нельзя — он тянет `node:fs`
// и хук резолва, которых в сборке вкладки нет, — поэтому берутся его ТИПЫ:
// импорт стирается сборкой, а списки полей ниже приколочены типом кортежа.
import type {
  CLIENT_BUILD_FIELDS,
  MATCH_DOCUMENT_FIELDS,
  MatchDocumentField,
} from '@fluxus/net/bin/matchFile.mjs';

/**
 * Адрес документа матча демо в дереве контента — ID-путь от корня (ASSET-2).
 *
 * Константа СБОРКИ, как прежде им был путь импорта: выбор матча страницей —
 * отдельный вопрос (Non-Goals дизайна). Константа именно адреса, а не байтов:
 * байты приезжают из раздачи оболочки (CONT-5).
 */
export const DEMO_MATCH_ID = 'matches/duel.match.json';

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
  'eventVisibility',
  'rewind',
  'pause',
  'physics',
  'locomotion',
  'visibility',
  'navigation',
];

/**
 * Поля документа, которые сборка потребляет САМА и в конфиг не передаёт
 * (`CONSUMED_BY_LAUNCHER` запускалок): `buildId` уезжает половиной версии
 * (NTR-5), контент-пак разворачивается чтением сцен из раздачи (CONT-5), а
 * порог молчания документ считает в секундах, тогда как конфиг — в тиках.
 */
const DEMO_CONSUMED_FIELDS = ['buildId', 'contentPack', 'scenes', 'silenceSeconds'] as const;

/**
 * Документ матча (`netcode-transport` NTR-14): секции `MatchConfig`, которые
 * он везёт как есть, ВЫВЕДЕНЫ из типа раскладки запускалок, а не переписаны
 * рядом (вторая запись тех же имён и есть способ им разойтись), плюс поля,
 * которые сборка потребляет сама.
 */
export interface DemoMatchDoc extends Partial<Pick<MatchConfig, MatchDocumentField>> {
  readonly name: string;
  readonly buildId: string;
  readonly seed: number;
  readonly players: readonly string[];
  readonly sceneRef: string;
  /** Ссылка сцены → путь к её файлу ОТНОСИТЕЛЬНО документа матча (CONT-5). */
  readonly contentPack?: Readonly<Record<string, string>>;
  /** Порог молчания слота в секундах; конфиг матча считает его в тиках. */
  readonly silenceSeconds?: number;
}

/**
 * Прочитанные документы контент-пака: документ матча и сцены, которые он
 * называет. То самое значение, которое раньше было содержимым модуля, — и
 * потому его теперь можно передать (конвертом сборки воркеру, D4) и прочитать
 * заново, а не «иметь».
 */
export interface DemoDocuments {
  readonly match: DemoMatchDoc;
  /** Сцены контент-пака ПО ССЫЛКЕ документа (`sceneRef`), как их адресует матч. */
  readonly scenes: Readonly<Record<string, SceneDef>>;
  /** ID-путь каждой сцены в дереве контента (ASSET-2): им адресуются парные документы. */
  readonly sceneIds: Readonly<Record<string, string>>;
}

/**
 * Ссылка внутри документа → ID-путь от корня дерева (CONT-5): ссылки в
 * документах относительные, потому что перемещение корня MUST NOT требовать
 * правки ни одного документа внутри него.
 *
 * Чистая функция над ID-путями — зеркало `resolve(dirname(file), scenePath)` из
 * `readMatchFile` запускалок: правило одно, предложение спеки одно, а совпадение
 * результата пинает тест (`test/demoDocuments.test.ts`). Выход за корень дерева
 * — НАЗВАННЫЙ отказ: у ID-пути корня нет родителя, и молча превратить такую
 * ссылку в путь значило бы выдумать адрес, которого раздача не отдаёт.
 */
export function demoContentId(baseId: string, reference: string): string {
  if (reference.startsWith('/')) {
    throw new Error(
      `демо: ссылка "${reference}" документа "${baseId}" не относительная; ` +
        'ссылки внутри документов задаются относительно самого документа (CONT-5)',
    );
  }
  const segments = baseId.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') {
      segments.push(part);
      continue;
    }
    if (segments.length === 0) {
      throw new Error(
        `демо: ссылка "${reference}" документа "${baseId}" ведёт за корень дерева контента (CONT-5)`,
      );
    }
    segments.pop();
  }
  return segments.join('/');
}

/** Байты документа из раздачи → JSON. Отказ называет ID документа и причину. */
async function readDocument<T>(source: AssetSource, id: string): Promise<T> {
  let bytes: ArrayBuffer;
  try {
    bytes = await source.read(id);
  } catch (error) {
    throw new Error(`демо: документ "${id}" не прочитан: ${String(error)}`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    throw new Error(`демо: документ "${id}" не разобран как JSON: ${String(error)}`);
  }
}

/**
 * Документы контент-пака из раздачи оболочки (CONT-5): документ матча по своему
 * ID-пути и каждая сцена, которую называет его `contentPack`.
 *
 * Источник байтов — тот же `AssetSource`, которым страница читает манифест и
 * парный presentation-документ (ASSET-2): второго способа добраться до дерева у
 * приложения нет, и заводить его незачем — «путь до корня дерева контента есть
 * свойство оболочки» сказано про один путь, а не про два.
 */
export async function loadDemoDocuments(
  source: AssetSource,
  matchId: string = DEMO_MATCH_ID,
): Promise<DemoDocuments> {
  const match = await readDocument<DemoMatchDoc>(source, matchId);
  const scenes: Record<string, SceneDef> = {};
  const sceneIds: Record<string, string> = {};
  for (const [ref, reference] of Object.entries(match.contentPack ?? {})) {
    const id = demoContentId(matchId, reference);
    sceneIds[ref] = id;
    scenes[ref] = await readDocument<SceneDef>(source, id);
  }
  return { match, scenes, sceneIds };
}

/**
 * Зависимости сборки мира, которые сборка отдаёт КЛИЕНТУ (NTR-14) — копия
 * `CLIENT_BUILD_FIELDS` запускалок, приколоченная ТИПОМ КОРТЕЖА, как и список
 * полей документа выше. Своя запись нужна потому, что помощник запускалок
 * тянет `node:fs` и в сборку вкладки не входит; расходиться двум записям типом
 * запрещено: разойдись они — предсказание клиента (NTR-10) тикало бы не тем
 * составом, что сервер, и заметить это можно было бы только по разошедшимся
 * дорогам NPC.
 */
export const DEMO_CLIENT_BUILD_FIELDS: typeof CLIENT_BUILD_FIELDS = [
  'physics',
  'locomotion',
  'visibility',
  'navigation',
];

/** Те же секции конфига для клиента — ровно объявленные, без `undefined`-ключей. */
export function demoClientBuildOptions(
  config: Pick<MatchConfig, (typeof DEMO_CLIENT_BUILD_FIELDS)[number]>,
): Partial<Pick<MatchConfig, (typeof DEMO_CLIENT_BUILD_FIELDS)[number]>> {
  // Отсутствующая секция ключом со значением `undefined` не становится: опции
  // клиента отличают «не назвали» от «назвали пустым» (NTR-14). Что тело не
  // отстало от списка, проверяет тест раскладки — сверкой ключей результата с
  // самим списком, а не с переписанными в нём именами.
  return {
    ...(config.physics !== undefined ? { physics: config.physics } : {}),
    ...(config.locomotion !== undefined ? { locomotion: config.locomotion } : {}),
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
    ...(config.navigation !== undefined ? { navigation: config.navigation } : {}),
  };
}

/** Каденс тика матча из документа; умолчание — то же, что у раскладки конфига. */
export function demoTickRateOf(document: DemoMatchDoc): number {
  return document.tickRate ?? 60;
}

/**
 * Каденс рассылки снапшотов из документа (NTR-11). Им же тонкий клиент задаёт
 * знаменатель альфы главного потока: доставки идут в темпе рассылки (SHELL-3,
 * REND-2), и умолчание здесь обязано быть тем же, что у раскладки конфига.
 */
export function demoSnapshotRateOf(document: DemoMatchDoc): number {
  return document.snapshotRate ?? 30;
}

/**
 * Настройки перемотки матча (NET-11): глубина буфера, cooldown вне отката и
 * орган ведения скраба. Читаются из документа матча обеими сборками демо —
 * сетевой и локальной (`worker.ts`): профиль истории и номер бита обязаны
 * совпасть, иначе ульта в одной сборке отматывает не туда, а в другой не
 * отматывает вовсе.
 */
export function demoRewindOf(document: DemoMatchDoc): MatchRewindOptions | undefined {
  return document.rewind;
}

/**
 * Поиск пути матча (NTR-14, `pathfinding` NAV-1): бюджет раскрытий и предел
 * радиуса агента. Читаются из документа обеими сборками демо — сетевой и
 * локальной (`sim.ts`), по той же причине, что настройки перемотки: собери одна
 * сборка навигацию, а другая нет — и NPC в них ходят разными дорогами при одной
 * сцене (NPC-6), причём в локальной сборке это некому заметить, сервера у неё
 * нет вовсе.
 */
export function demoNavigationOf(document: DemoMatchDoc): NavigationOptions | undefined {
  return document.navigation;
}

/**
 * Тиков между шагами ведения точки перемотки (REW-13). Сервер делает шаг раз в
 * ЦИКЛ РАССЫЛКИ, то есть каждые `tickRate / snapshotRate` тиков; локальная
 * оболочка своей рассылки не имеет и берёт ту же величину отсюда.
 *
 * Выводится, а не берётся умолчанием оболочки: совпадение чисел — совпадение, а
 * не правило, и разойдись они, ульта отматывала бы на разную глубину за одно и
 * то же удержание в зависимости от того, кто произвёл тик (SHELL-8).
 */
export function demoScrubEveryOf(document: DemoMatchDoc): number {
  return Math.max(1, Math.round(demoTickRateOf(document) / demoSnapshotRateOf(document)));
}

/** Контент-пак клиента: сцену он резолвит локально, сервер её не раздаёт (NET-16). */
export function demoContentPack(documents: DemoDocuments): LoadedContentPack {
  return contentPack(documents.scenes);
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
  const tickRate = demoTickRateOf(document);
  return {
    ...(carried as Pick<MatchConfig, MatchDocumentField>),
    // Версия матча (NET-16): сборка плюс хеш контент-пака, посчитанный из
    // ПРОЧИТАННОЙ сцены — тем же кодом, каким его считает сервер (NET-17).
    version: { buildId: document.buildId, contentPackHash: pack.hash },
    scene,
    initial: document.initial ?? [],
    tickRate,
    snapshotRate: demoSnapshotRateOf(document),
    inputDelay: document.inputDelay ?? 2,
    silenceTicks: (document.silenceSeconds ?? 10) * tickRate,
  };
}

/**
 * Конфиг матча демо-арены. Зависимости сборки мира (NTR-14) едут из документа
 * матча, а не из умолчаний кода: сцена, рассчитанная на интегрирующую физику,
 * без них молча стояла бы на месте.
 */
export function demoMatchConfig(
  documents: DemoDocuments,
  pack: LoadedContentPack = demoContentPack(documents),
): MatchConfig {
  return demoMatchConfigOf(documents.match, pack);
}
