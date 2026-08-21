/**
 * Типы к `trace.mjs` — ради теста слоя запускалок (`test/traceCli.test.ts`).
 *
 * Отдельным файлом, а не переписыванием бина на TypeScript: `bin/` — слой
 * командной строки, он исполняется `node` напрямую и в tsconfig пакета не
 * входит намеренно (шапка `core-ts/bin/sim.mjs`: шага сборки у команд нет). Тот
 * же приём уже применён к `scripts/spec-graph.mjs`.
 *
 * Объявление проверяется тестом на разрыв: он зовёт КАЖДОЕ имя отсюда, и
 * переименование экспорта в бине краснеет импортом, а не остаётся здесь
 * тихой ложью.
 */
import type { DiagnosticRecord, TraceSelect } from '@game-mvp/core';
import type { MatchTrace } from '../src/match/trace.js';

/** Разобранные флаги трейса (CLI-11). */
export interface TraceFlags {
  readonly level: 'off' | 'systems' | 'full';
  readonly select: TraceSelect | undefined;
  readonly out: string | undefined;
}

/** Писатель строк, ловящий отказ записи сам (DIAG-8, design Decision 10). */
export interface LineWriter {
  readonly failure: string | undefined;
  write(line: string): void;
  close(): void;
}

/** Открытый трейс матча: sink для сборки мира плюс один канал отказа записи. */
export interface OpenedMatchTrace {
  readonly trace: MatchTrace;
  readonly failure: string | undefined;
  close(): void;
}

export declare const TRACE_USAGE: string;
export declare const TRACE_WITHOUT_RECORD: string;

export declare function parseTraceSelect(spec: string | undefined): TraceSelect | undefined;
export declare function guardedLineWriter(
  write: (line: string) => void,
  finish: () => void,
): LineWriter;
export declare function fileLineWriter(path: string): LineWriter;
/**
 * Умолчания задаются так же, как их задаёт командная строка: `select` — СТРОКА
 * отбора, а не готовый предикат (её разбирает `parseTraceSelect` внутри).
 */
export declare function traceOptions(defaults?: {
  readonly level?: TraceFlags['level'];
  readonly select?: string;
  readonly out?: string;
}): TraceFlags;
export declare function openMatchTrace(options: TraceFlags): OpenedMatchTrace | undefined;

/** Реэкспорт ради краткости в тесте: запись диагностики — вход отбора. */
export type { DiagnosticRecord };
