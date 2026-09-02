/**
 * Типы программного API scripts/workspaces.mjs — для тестов карты влияния в
 * integration-ts. Сам скрипт остаётся .mjs вне tsconfig пакетов, как остальные
 * CLI-бины (тот же случай, что spec-graph.d.mts).
 */
export interface WorkspacePackage {
  /** Путь пакета от корня репозитория: `engine/core-ts`. */
  dir: string;
  /** Имя из манифеста: `@fluxus/core`, оно же имя проекта vitest. */
  name: string;
  /** Имена пакетов репозитория из всех трёх секций зависимостей. */
  deps: string[];
}

export const REPO_ROOT: string;

export function loadWorkspaces(repoRoot?: string): WorkspacePackage[];

export function resolveSelectors(
  selectors: readonly string[],
  workspaces: readonly WorkspacePackage[],
): WorkspacePackage[];
