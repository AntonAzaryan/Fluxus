/**
 * Общее для запускалок: хук резолва (`tsHook.mjs`, импортируется ради его
 * побочного действия) и чтение файла матча.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import './tsHook.mjs';

/**
 * Файл матча описывает и данные матча, и контент-пак, которым его поднимать.
 * В бою эти две вещи разъезжаются: контент-пак у клиента свой, а данные матча
 * приезжают в `Welcome` (NTR-5). Здесь они в одном файле только потому, что
 * локальный прогон поднимает обе стороны с одной машины.
 */
export function readMatchFile(path) {
  const file = resolve(process.cwd(), path);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(file);
  const scenes = {};
  for (const [ref, scenePath] of Object.entries(raw.contentPack ?? {})) {
    scenes[ref] = JSON.parse(readFileSync(resolve(base, scenePath), 'utf8'));
  }
  return { ...raw, scenes };
}

/**
 * Поля документа матча, которые запускалка потребляет САМА и в конфиг не
 * передаёт: контент-пак разворачивается чтением файлов в `scenes`, `buildId`
 * уезжает половиной версии (NTR-5), а порог молчания документ считает в
 * секундах, тогда как конфиг — в тиках.
 */
const CONSUMED_BY_LAUNCHER = ['buildId', 'contentPack', 'scenes', 'silenceSeconds'];

/**
 * Поля `MatchConfig`, которые документ матча везёт КАК ЕСТЬ.
 *
 * Список этот — НЕ список копирования: копирует остаток документа (`...carried`
 * в `matchConfigOf`), поэтому новая секция доезжает до сервера сама. Ровно
 * этого не хватало прежней раскладке: она перечисляла имена поимённо и потому
 * теряла каждую секцию, которую забыли дописать, — молча и без следа. Так была
 * потеряна `rewind`, и вместе с ней ульта отката на выделенном стенде: событие
 * `$rewind/request` приезжало в матч, поднятый без истории, и отбрасывалось.
 *
 * Нужен список для ОТКАЗА: ключ, которого в нём нет, `MatchServer` не читает, и
 * молча донести его до конфига значило бы выдать опечатку («rewnd») за
 * настройку. Полярность отказа в этом и состоит — забытое имя теперь роняет
 * запуск с названным ключом, а не убирает поведение из матча.
 */
export const MATCH_DOCUMENT_FIELDS = [
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
 * Поля `MatchConfig`, которые назначает СБОРКА запуска, а не документ: версия и
 * сцена выводятся из документа и контент-пака, порог молчания пересчитывается
 * из секунд в тики, а наблюдатель, наблюдатели тика, трейс и приёмник
 * диагностики перемотки — решения запуска (`serve.mjs`, стенд демо), не
 * свойства матча.
 *
 * Названы они здесь не ради копирования, а ради отказа с внятной причиной:
 * документ, объявивший `allowObserver`, ошибается не опечаткой, и сказать ему
 * об этом надо иначе, чем про неизвестный ключ. Вместе с
 * `MATCH_DOCUMENT_FIELDS` список обязан покрывать `keyof MatchConfig` целиком —
 * это проверяется типом в `test/matchFile.test.ts`.
 */
export const LAUNCHER_FIELDS = [
  'version',
  'scene',
  'silenceTicks',
  'allowObserver',
  'observers',
  'trace',
  'rewindWarn',
];

/**
 * Отказ на ключе, которого сервер матча не читает. Громко и до первого тика:
 * секция, которую конфиг проглотил бы молча, — это ровно тот дефект, который
 * ищут потом в геймплее (ульта «не работает»), а не в файле матча.
 */
function rejectUnknownFields(carried) {
  const unknown = Object.keys(carried).filter((key) => !MATCH_DOCUMENT_FIELDS.includes(key));
  if (unknown.length === 0) return;
  const causes = unknown.map((key) =>
    LAUNCHER_FIELDS.includes(key)
      ? `"${key}" — поле сборки запуска, а не документа матча`
      : `"${key}" сервером матча не читается`,
  );
  throw new Error(
    `документ матча: ${causes.join('; ')}. ` +
      `Поля документа: ${[...MATCH_DOCUMENT_FIELDS, ...CONSUMED_BY_LAUNCHER].join(', ')}`,
  );
}

/**
 * Поля документа матча, которые запускалка отдаёт КЛИЕНТУ (NTR-14): «обе стороны
 * получают зависимости сборки из одного описания матча». Список ровно один на
 * все запускалки — и это несущее: сервер получает секции документа ОСТАТКОМ
 * объекта (`matchConfigOf`), а клиент — перечислением, и перечисление,
 * переписанное в каждом файле запуска, отставало от документа молча. Ровно так
 * и отстала навигация: сервер водил NPC по найденным путям, а предсказание
 * клиента (NTR-10) — прямым seek, при формально одном мире.
 *
 * Список — подмножество `MATCH_DOCUMENT_FIELDS`: клиент берёт из документа
 * только то, что нужно ЕГО сборке мира. Проверяется он двумя половинами
 * (`test/matchFile.test.ts`), и обе нужны. Полнота считается ОТ ДОКУМЕНТА:
 * список обязан совпасть с `MATCH_DOCUMENT_FIELDS` минус секции, объявленные
 * серверными поимённо и с причиной, — счёт от опций клиента был согласован сам
 * с собой и потому пропустил `locomotion`, которого не было ни там, ни там.
 * Обратная половина — типовая: каждое имя списка обязано приниматься опциями
 * клиента матча, иначе `npm run typecheck` краснеет до прогона.
 */
export const CLIENT_BUILD_FIELDS = ['physics', 'locomotion', 'visibility', 'navigation'];

/**
 * Зависимости сборки мира для клиента — ровно те секции документа, которые он
 * объявил. Отсутствующая секция не превращается в `undefined`-ключ: опции
 * клиента отличают «не назвали» от «назвали пустым» (NTR-14).
 */
export function clientBuildOptions(match) {
  const options = {};
  for (const field of CLIENT_BUILD_FIELDS) {
    if (match[field] !== undefined) options[field] = match[field];
  }
  return options;
}

/**
 * Документ матча → `MatchConfig`. Одно место на все запускалки: разойдись они
 * в раскладке, и два стенда с одним файлом матча подняли бы разные миры — то
 * есть разошлись бы хешем `worldInit` (NTR-5) на честных данных.
 *
 * Секции документа едут ЦЕЛИКОМ, остатком объекта, а не перечислением имён:
 * зависимости сборки мира (NTR-14 — физика, локомоция, пересчёт видимости, поиск пути),
 * история перемотки (NET-11, SNAP-4), темп и всё, что документ научится
 * называть завтра, — свойства матча, а не умолчания запускалки. Выводятся
 * здесь только те поля, которых в документе нет буквально: версия, сцена из
 * контент-пака и порог молчания в тиках.
 */
export function matchConfigOf(match, pack) {
  const carried = { ...match };
  for (const field of CONSUMED_BY_LAUNCHER) delete carried[field];
  rejectUnknownFields(carried);
  const tickRate = match.tickRate ?? 60;
  return {
    ...carried,
    version: { buildId: match.buildId, contentPackHash: pack.hash },
    scene: pack.scene(match.sceneRef),
    initial: match.initial ?? [],
    tickRate,
    snapshotRate: match.snapshotRate ?? 30,
    inputDelay: match.inputDelay ?? 2,
    silenceTicks: (match.silenceSeconds ?? 10) * tickRate,
  };
}

/**
 * Те же данные матча БЕЗ «кто играет»: версию и ростер лобби собирает само
 * (`net-session` SES-4), поэтому `HostSession` принимает конфиг без них.
 */
export function matchDataOf(match, pack) {
  const config = { ...matchConfigOf(match, pack) };
  delete config.version;
  delete config.players;
  return config;
}

/**
 * Признак-флаг: значения у него нет, поэтому опознаётся он ТОЛЬКО голой формой
 * `--name`. Форму `--name=<...>` он не читает намеренно: `--debug=false`
 * означал бы «отладочный прогон включён», а это ровно тот вид ошибки, ради
 * которого разбор флагов вообще правится (CLI-11).
 *
 * Флаг, у которого значение бывает (`--trace`), разбирается не здесь, а
 * `option`: голая форма приезжает туда умолчанием.
 */
export function flag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * Значение флага в ОБЕИХ формах — `--name=value` и `--name value`.
 *
 * Обе, потому что обе напечатаны: `=` стоит в usage запускалок, в шапке
 * `bin/trace.mjs`, в `CLAUDE.md` и в CLI прогона сценария (`bin/sim.mjs`
 * принимает только её), раздельная — в примерах запуска стенда. CLI-11 требует
 * принимать параметры трейса «тем же образом, каким их принимает CLI прогона
 * сценария», и форма, которая молча не срабатывает, — это не отказ, а прогон,
 * делающий не то, что написано в команде.
 *
 * Побеждает ПЕРВОЕ вхождение — как и раньше у раздельной формы; поиск идёт
 * слева направо и обе формы для него равны.
 */
export function option(name, fallback) {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}` && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return fallback;
}
