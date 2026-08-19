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
 * Документ матча → `MatchConfig`. Одно место на все запускалки: разойдись они
 * в раскладке, и два стенда с одним файлом матча подняли бы разные миры — то
 * есть разошлись бы хешем `worldInit` (NTR-5) на честных данных.
 *
 * Зависимости сборки мира (NTR-14) едут отсюда же и целиком: физика, локомоция
 * и пересчёт видимости — свойства матча, а не умолчания запускалки.
 */
export function matchConfigOf(match, pack) {
  const tickRate = match.tickRate ?? 60;
  return {
    version: { buildId: match.buildId, contentPackHash: pack.hash },
    players: match.players,
    seed: match.seed,
    sceneRef: match.sceneRef,
    scene: pack.scene(match.sceneRef),
    initial: match.initial ?? [],
    name: match.name,
    tickRate,
    snapshotRate: match.snapshotRate ?? 30,
    inputDelay: match.inputDelay ?? 2,
    ...(match.inputWindow !== undefined ? { inputWindow: match.inputWindow } : {}),
    ...(match.eventRepeat !== undefined ? { eventRepeat: match.eventRepeat } : {}),
    silenceTicks: (match.silenceSeconds ?? 10) * tickRate,
    ...(match.physics !== undefined ? { physics: match.physics } : {}),
    ...(match.locomotion !== undefined ? { locomotion: match.locomotion } : {}),
    ...(match.visibility !== undefined ? { visibility: match.visibility } : {}),
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
