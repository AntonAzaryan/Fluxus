/**
 * Командная строка импорта (BLND-5, BLND-7): `npm run import -- <путь к .glb>`
 * из корня репозитория.
 *
 * Своей логики импорта здесь нет ни строки — есть разбор аргументов, хост среды
 * Node (ED-12) и печать результата. Импорт выполняет та же зарегистрированная
 * операция, что исполнил бы редактор, и сохраняет тот же канонический канал
 * (ED-21): «командная строка и редактор дают байт-в-байт одно» держится на том,
 * что второго пути не существует, а не на сверке двух реализаций.
 *
 * Режим `--dry-run` печатает результат JSON'ом в stdout и не пишет ничего: это
 * мост для живой проверки аддона (BLND-8, задача 8.5) — Python зовёт Node
 * подпроцессом и читает находки, вместо того чтобы заводить второй перечень
 * правил на своей стороне.
 *
 * Режим `--watch` следит за источником и гоняет тот же импорт на каждое
 * сохранение (BLND-12). Своей логики у него здесь тоже нет: слежение, дебаунс и
 * «последний валидный результат при ошибке» — в `watch.ts`, а сюда приходит
 * разбор флага и вызов.
 *
 * Отчёт человеку идёт в stderr, машинный JSON — в stdout и только он: смешать
 * их значило бы сломать мост первым же предупреждением.
 */
import { resolve } from 'node:path';
import {
  crossDocumentRules,
  engineValidationRules,
  type ContentPath,
  type ContributionReader,
  type ValidationRule,
} from '@game-mvp/editor-core';
import { runImport, type ImportResult } from './importer.js';
import { createNodeHost } from './nodeHost.js';
import { isSourcePath } from './pairing.js';
import { DEFAULT_IMPORT_KINDS, DEFAULT_MANIFEST_PATH } from './project.js';
import { DEFAULT_DECORATIONS_PATH, DEFAULT_INITIAL_PATH } from './operation.js';
import { importResources, reportFindings } from './report.js';
import { runImportWatch } from './watch.js';

export interface CliOptions {
  readonly source: ContentPath;
  readonly root: string;
  readonly manifest: ContentPath | null;
  readonly dryRun: boolean;
  /** Следить за источником и импортировать на каждое сохранение (BLND-12). */
  readonly watch: boolean;
  readonly locale: string;
}

export class CliError extends Error {}

const USAGE = [
  'npm run import -- <путь к .glb|.gltf> [--dry-run | --watch] [--root <каталог>] [--manifest <путь>]',
  '',
  '  <путь>        экспорт источника; конфиг сцены находится по имени рядом (BLND-2)',
  '  --dry-run     те же проверки и тот же целевой слой, но без записи; результат JSON в stdout',
  '  --watch       следить за источником и импортировать на каждое сохранение (BLND-12)',
  '  --root        корень дерева контента; по умолчанию — content/ рядом с рабочим каталогом',
  '  --manifest    манифест визуалов; по умолчанию — visuals/manifest.json, `none` — не проверять',
  '  --locale      локаль сообщений валидации (ru | en)',
].join('\n');

/**
 * Путь источника внутри дерева контента. Абсолютный путь и путь относительно
 * рабочего каталога принимаются оба — автор зовёт команду с тем путём, который
 * ему подставила оболочка, — но за корень дерева выйти нельзя: у редактора и
 * загрузчика ассетов ID документа есть путь ОТ КОРНЯ (ASSET-2), и файл снаружи
 * дерева документом не является.
 */
export function contentPathOf(root: string, argument: string): ContentPath {
  const absolute = resolve(argument);
  const base = resolve(root);
  if (absolute === base || !absolute.startsWith(`${base}/`)) {
    throw new CliError(`путь "${argument}" лежит вне дерева контента "${base}"`);
  }
  return absolute.slice(base.length + 1).replaceAll('\\', '/');
}

export function parseArgs(argv: readonly string[], cwd: string): CliOptions {
  let source: string | undefined;
  let root: string | undefined;
  let manifest: string | undefined;
  let dryRun = false;
  let watch = false;
  let locale = 'ru';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new CliError(`флаг "${arg}" без значения`);
      i++;
      return next;
    };
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--watch') watch = true;
    else if (arg === '--root') root = value();
    else if (arg === '--manifest') manifest = value();
    else if (arg === '--locale') locale = value();
    else if (arg.startsWith('--')) throw new CliError(`неизвестный флаг "${arg}"\n\n${USAGE}`);
    else if (source === undefined) source = arg;
    else throw new CliError(`лишний аргумент "${arg}"\n\n${USAGE}`);
  }

  if (source === undefined) throw new CliError(`не назван источник\n\n${USAGE}`);
  if (!isSourcePath(source)) {
    throw new CliError(`"${source}": импорт читает экспорт glTF — файл .glb либо .gltf (BLND-3)`);
  }
  // Проверка без записи и слежение с записью — взаимоисключающие ответы на
  // вопрос «пишем ли мы документы»; сведённые в один запуск, они значили бы
  // «следи и ничего не делай», то есть не значили бы ничего.
  if (dryRun && watch) throw new CliError(`"--dry-run" и "--watch" вместе не бывают\n\n${USAGE}`);
  const directory = resolve(cwd, root ?? 'content');
  return {
    source: contentPathOf(directory, resolve(cwd, source)),
    root: directory,
    manifest: manifest === 'none' ? null : (manifest ?? DEFAULT_MANIFEST_PATH),
    dryRun,
    watch,
    locale,
  };
}

/**
 * Правила, которыми проверяется результат импорта (BLND-6: «на общих
 * основаниях», ED-8). Те же вклады, что подсвечивают нарушения в редакторе:
 * своих проверок у импорта нет, а раскладку документов приносит собирающий
 * инструмент (ED-25) — здесь она и названа.
 *
 * Описаний камеры (ASSET-8, ASSET-10) инструмент не подаёт: их перечни живут в
 * коде камеры, а тянуть рендер в headless-импортёр ради секции, которой импорт
 * не касается, значило бы платить зависимостью за чужую проверку.
 */
export function cliValidationRules(): ContributionReader<ValidationRule> {
  const kinds = DEFAULT_IMPORT_KINDS;
  const rules = [
    ...engineValidationRules({
      scene: kinds.scene,
      manifest: kinds.manifest,
      // Отдельных документов террейна, кривизны и систем у цели импорта нет:
      // виды остаются умолчальными, и правила по ним просто не срабатывают.
      terrain: 'terrain',
      curvature: 'curvature',
      system: 'system',
    }),
    ...crossDocumentRules(
      { scene: kinds.scene, manifest: kinds.manifest, curvature: 'curvature', presentation: kinds.presentation },
      [{ kind: kinds.scene, path: DEFAULT_INITIAL_PATH }],
      [{ kind: kinds.scene, path: ['terrain'] }],
      [{ kind: kinds.presentation, path: DEFAULT_DECORATIONS_PATH }],
    ),
  ];
  const byId = new Map(rules.map((rule) => [rule.id, rule] as const));
  const all = Object.freeze([...byId.values()]);
  return { get: (id) => byId.get(id), has: (id) => byId.has(id), all: () => all };
}

/**
 * Результат JSON'ом — мост для аддона (BLND-8) и для правила синхронизации.
 *
 * Слой уезжает целиком, включая клеточные слои (BLND-9, BLND-10): «что уедет в
 * документы» — то, ради чего живая проверка и зовётся, а слот, которого в ответе
 * нет, читатель отличить от «источник его не даёт» не сможет. Отсутствие слота
 * при этом значимо и здесь: ключа нет ровно тогда, когда ассет не переписывается.
 */
export function resultJson(result: ImportResult): string {
  const { terrain, curvature } = result.layer;
  return JSON.stringify(
    {
      ok: result.ok,
      dryRun: result.dryRun,
      source: result.source,
      scene: result.scene,
      presentation: result.presentation,
      findings: result.findings,
      layer: {
        initial: result.layer.initial,
        decorations: result.layer.decorations,
        ...(terrain === undefined ? {} : { terrain }),
        ...(curvature === undefined ? {} : { curvature }),
      },
      changes: result.changes,
      written: result.written,
      refusal: result.refusal,
      blocking: result.blocking,
    },
    null,
    2,
  );
}

export interface CliIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Возвращает код выхода: 0 — импорт состоялся, 1 — отказ, 2 — ошибка вызова. */
export async function main(argv: readonly string[], cwd: string, io: CliIo): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const host = createNodeHost({ root: options.root });
  if (options.watch) {
    // Слежение — тот же импорт, только повторяемый: своей записи, своих правил
    // и своего формата сообщений у него нет (BLND-12, design 12).
    return runImportWatch({
      host: host.content,
      root: options.root,
      source: options.source,
      manifest: options.manifest,
      rules: cliValidationRules(),
      locale: options.locale,
      io,
    });
  }

  let result: ImportResult;
  try {
    result = await runImport({
      host: host.content,
      source: options.source,
      manifest: options.manifest,
      dryRun: options.dryRun,
      rules: cliValidationRules(),
    });
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.dryRun) io.out(resultJson(result));

  reportFindings(result, io.err, importResources(options.locale));

  if (!result.ok) {
    io.err(result.refusal ?? `импорт "${options.source}" отвергнут: на диск не записано ничего (BLND-6)`);
    return 1;
  }
  if (options.dryRun) {
    io.err(`проверка "${options.source}" прошла: записи не было (--dry-run)`);
    return 0;
  }
  io.err(
    result.written.length === 0
      ? `импорт "${options.source}": документы уже совпадают с источником, записи не было (BLND-4)`
      : `импорт "${options.source}": записаны ${result.written.join(', ')}`,
  );
  return 0;
}
