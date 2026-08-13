/**
 * Типы программного API scripts/spec-graph.mjs — для теста-на-формат в
 * integration-ts (specGraph.test.ts). Сам скрипт остаётся .mjs вне tsconfig
 * пакетов, как остальные CLI-бины.
 */
export interface SpecRequirement {
  id: string;
  title: string;
  capability: string;
  file: string;
  line: number;
  body: string;
}

export interface SpecCapability {
  name: string;
  file: string;
  title: string;
  purpose: string;
  requirementIds: string[];
}

export interface SpecMention {
  fromId: string;
  toId: string;
  declaredCap: string | null;
  file: string;
  line: number;
}

export interface SpecDuplicate {
  id: string;
  file: string;
  line: number;
  firstFile: string;
  firstLine: number;
}

export interface CapEdge {
  from: string;
  to: string;
  weight: number;
  refs: Set<string>;
}

export interface SpecModel {
  specsDir: string;
  capabilities: Map<string, SpecCapability>;
  requirements: Map<string, SpecRequirement>;
  duplicates: SpecDuplicate[];
  mentions: SpecMention[];
  edges: SpecMention[];
  dangling: SpecMention[];
  capEdges: Map<string, CapEdge>;
}

export interface LayersConfig {
  order: string[];
  layers: Record<string, string>;
  exceptions: { from: string; to: string; reason: string }[];
}

export interface Finding {
  rule:
    | 'duplicate-id'
    | 'dangling'
    | 'dangling-code'
    | 'attribution-mismatch'
    | 'missing-modality'
    | 'unmapped-capability'
    | 'content-boundary';
  where: string;
  message: string;
}

export type CodeCategory = 'src' | 'test' | 'generated';

export interface CodeMention {
  id: string;
  file: string;
  line: number;
  category: CodeCategory;
}

export interface CodeIndex {
  roots: string[];
  mentions: CodeMention[];
  byId: Map<string, CodeMention[]>;
}

export interface SpecMetrics {
  topFanIn: { id: string; count: number; capability: string }[];
  instability: { capability: string; ce: number; ca: number; instability: number }[];
  orphans: string[];
  upwardEdges: {
    from: string;
    to: string;
    fromLayer: string;
    toLayer: string;
    weight: number;
    accepted: boolean;
    refs: string[];
  }[];
}

export declare const DEFAULT_SPECS_DIR: string;
export declare const DEFAULT_LAYERS_PATH: string;
export declare const DEFAULT_CODE_ROOTS: string[];
export declare function buildModel(specsDir?: string): SpecModel;
export declare function loadLayers(layersPath?: string): LayersConfig;
export declare function buildCodeIndex(roots?: string[]): CodeIndex;
export declare function lint(
  model: SpecModel,
  layers: LayersConfig,
  codeIndex?: CodeIndex | null,
): Finding[];
export declare function metrics(model: SpecModel, layers: LayersConfig): SpecMetrics;
