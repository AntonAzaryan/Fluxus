/**
 * Типы программного API scripts/impact.mjs — для тестов карты влияния и её
 * сторожа в integration-ts. Сам скрипт остаётся .mjs вне tsconfig пакетов, как
 * остальные CLI-бины (тот же случай, что spec-graph.d.mts).
 */
import type { WorkspacePackage } from './workspaces.mjs';

/** Класс пути: полный гейт, документный прогон или принадлежность пакету. */
export type PathKind = 'full' | 'docs' | 'pkg';

/** Правило карты: имя, причина в человеческом виде и предикат по пути. */
export interface PathRule {
  rule: string;
  why: string;
  match(path: string): boolean;
}

export const WIDE_GATES: PathRule[];
export const DOC_RULES: PathRule[];
/** «Читающий ← читаемые»: пакет читает чужое дерево мимо манифеста. */
export const TEST_EDGES: Record<string, string[]>;
export const ALWAYS_ON_CODE: string;

export interface Classification {
  kind: PathKind;
  rule: string;
  why: string;
  /** Каталог пакета — только для kind: 'pkg'. */
  pkg?: string;
}

export function classify(path: string, workspaces: readonly WorkspacePackage[]): Classification;

export function closure(
  seeds: readonly string[],
  workspaces: readonly WorkspacePackage[],
  testEdges?: Readonly<Record<string, readonly string[]>>,
): Map<string, string>;

export type PlanKind = 'full' | 'docs' | 'selective' | 'global-only';

export interface PlanPackage {
  dir: string;
  name: string;
  why: string;
}

export interface Plan {
  kind: PlanKind;
  rules: (Classification & { path: string })[];
  packages: PlanPackage[];
  typecheck: string[];
  lint: string[];
  test: string[];
  global: boolean;
}

export function planFor(
  paths: readonly string[],
  workspaces: readonly WorkspacePackage[],
  testEdges?: Readonly<Record<string, readonly string[]>>,
): Plan;

export function resolveBase(explicit?: string | null): {
  base: string | null;
  ref?: string;
  warning: string | null;
};

export function trackedPaths(): string[];

export function changedPaths(base: string | null): string[];

/** Снимок дерева: статусные строки и патч содержимого отслеживаемых файлов. */
export interface TreeSnapshot {
  status: string;
  patch: string;
}

export function treeSnapshot(): TreeSnapshot;

export function snapshotDiff(before: TreeSnapshot, after: TreeSnapshot): string[];

export interface Stage {
  name: string;
  cmd: [string, string[]];
}

export function stagesFor(plan: Plan, jobs?: number | null): Stage[];
