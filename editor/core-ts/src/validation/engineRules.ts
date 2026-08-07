/**
 * @contribution Правила валидации, вносимые движком (ED-25): доменные имена
 * редактируемого живут здесь, а не в каркасе.
 *
 * Ни одной проверки данных этот файл не содержит — он состоит из вызовов чужих
 * валидаторов. Так требует ED-1: правило, чей источник — ядро, применяется
 * вызовом ядра, а вторая реализация правила с одним источником истины
 * расходится с ним по определению (CORE-3). Поэтому здесь только три вещи:
 * какой валидатор звать на каком виде документа, что ему передать и как его
 * ответ превратить в структурную находку (`adapters.ts`).
 *
 * Виды документов приходят параметром, а не зашиты строками: одни и те же
 * правила должны собираться и на проекте, где сцена называется иначе. Значения
 * по умолчанию — рядом, чтобы обычная сборка была одной строкой.
 *
 * Чего эти правила не дают и дать не могут: адреса внутри документа для
 * валидаторов ядра. `loadScene`, `createTerrainGrid` и `validateSystem`
 * бросают на первом нарушении и путь не возвращают, поэтому находка адресует
 * документ целиком, а место называет дословным сообщением ядра. Это не обход
 * ED-30, а его предел на сегодняшней поверхности ядра: разобрать прозу на путь
 * значило бы завести у себя знание о её формулировках.
 */
import {
  EvaluatedSystem,
  createTerrainGrid,
  loadScene,
  validateSystem,
  type Scene,
  type SceneDef,
  type SystemDef,
  type TerrainDef,
} from '@game-mvp/core';
import { validateCurvatureMap, validateManifest } from '@game-mvp/assets';
import type { DocumentKind, EditorDocument } from '../document/index.js';
import { reportErrorList, reportThrown } from './adapters.js';
import { ruleDescriptionKey } from './reasons.js';
import type { ValidationRule, ValidationRun } from './types.js';

/** Виды редактируемого, на которых стоят правила движка. */
export interface EngineRuleKinds {
  readonly scene: DocumentKind;
  readonly terrain: DocumentKind;
  readonly curvature: DocumentKind;
  readonly manifest: DocumentKind;
  readonly system: DocumentKind;
}

export const DEFAULT_ENGINE_KINDS: EngineRuleKinds = Object.freeze({
  scene: 'scene',
  terrain: 'terrain',
  curvature: 'curvature',
  manifest: 'manifest',
  system: 'system',
});

/** Кто проверял — уезжает в ожидание находки, чтобы вопрос «чьё правило» не гадался. */
export const LOAD_SCENE = '@game-mvp/core:loadScene';
export const CREATE_TERRAIN_GRID = '@game-mvp/core:createTerrainGrid';
export const VALIDATE_SYSTEM = '@game-mvp/core:validateSystem';
export const VALIDATE_MANIFEST = '@game-mvp/assets:validateManifest';
export const VALIDATE_CURVATURE_MAP = '@game-mvp/assets:validateCurvatureMap';

export const SCENE_RULE = 'core.scene';
export const TERRAIN_RULE = 'core.terrain';
export const SYSTEM_RULE = 'core.system';
export const MANIFEST_RULE = 'assets.manifest';
export const CURVATURE_RULE = 'assets.curvature';

/**
 * Поднятая сцена или отказ. Отказ хранится, а не выбрасывается заново: сцену за
 * один прогон поднимают два правила — своё и правило систем, которому нужен
 * мир, — и второй подъём был бы вторым `createWorld` на ту же правку.
 */
type LoadedScene = { readonly ok: true; readonly scene: Scene } | { readonly ok: false; readonly error: unknown };

function loadedScene(run: ValidationRun, document: EditorDocument): LoadedScene {
  return run.derive(`loadScene ${document.id}`, (): LoadedScene => {
    const value = run.valueOf(document.id);
    try {
      return { ok: true, scene: loadScene(value as unknown as SceneDef) };
    } catch (error) {
      return { ok: false, error };
    }
  });
}

/**
 * Конфиг сцены целиком (SER-7): состав компонентов, prefabs, системы,
 * начальная расстановка и ассеты арены проверяет `loadScene` — тот же вызов,
 * которым сцену поднимает игровой клиент.
 */
export function sceneRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: SCENE_RULE,
    descriptionKey: ruleDescriptionKey(SCENE_RULE),
    appliesTo: [kinds.scene],
    check(run) {
      const loaded = loadedScene(run, run.document);
      if (loaded.ok) return;
      // Бросок уже пойман `loadedScene`; переходник вызывается на нём же,
      // чтобы форма находки была той же, что у остальных правил.
      reportThrown(run, { by: LOAD_SCENE }, () => {
        throw loaded.error;
      });
    },
  };
}

/**
 * Ассет террейна (TERR-2, TERR-3, TERR-7): диапазоны, алфавиты карт и ширина
 * рампы. Всё это знает `createTerrainGrid` — тот же вызов, которым террейн
 * поднимает сцена.
 */
export function terrainRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: TERRAIN_RULE,
    descriptionKey: ruleDescriptionKey(TERRAIN_RULE),
    appliesTo: [kinds.terrain],
    check(run) {
      const value = run.valueOf(run.document.id);
      reportThrown(run, { by: CREATE_TERRAIN_GRID }, () => {
        createTerrainGrid(value as unknown as TerrainDef);
      });
    },
  };
}

/**
 * JSON-система (SYS-3). Проверка требует мира: имена компонентов и prefabs
 * система называет, а знает их мир. Поэтому правило проверяет систему против
 * каждой открытой сцены — «система не подходит вот к этой сцене» и есть то
 * нарушение, которое автор чинит.
 *
 * Пара вызовов — та же, что в `SystemRegistry.registerFromJson`: сперва дерево
 * действий, затем конструктор, проверяющий имя, порядок и форму тела.
 */
export function systemRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: SYSTEM_RULE,
    descriptionKey: ruleDescriptionKey(SYSTEM_RULE),
    appliesTo: [kinds.system],
    check(run) {
      const def = run.valueOf(run.document.id) as unknown as SystemDef;
      for (const sceneDocument of run.documentsOfKind(kinds.scene)) {
        const loaded = loadedScene(run, sceneDocument);
        // Сломанная сцена молчит: об этом отчитывается её собственное правило,
        // а система против непостроенного мира не проверяема ничем.
        if (!loaded.ok) continue;
        reportThrown(run, { by: VALIDATE_SYSTEM, params: { against: sceneDocument.id } }, () => {
          validateSystem(def, loaded.scene.world);
          new EvaluatedSystem(def);
        });
      }
    },
  };
}

/** Манифест визуалов (ASSET-6, ASSET-8) — ED-14 требует тех же проверок в реальном времени. */
export function manifestRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: MANIFEST_RULE,
    descriptionKey: ruleDescriptionKey(MANIFEST_RULE),
    appliesTo: [kinds.manifest],
    check(run) {
      const value = run.valueOf(run.document.id);
      reportErrorList(run, { by: VALIDATE_MANIFEST }, validateManifest(value));
    },
  };
}

/** Карта кривизны (ASSET-7) — алфавит и форма сетки; ED-11 требует их сразу. */
export function curvatureRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: CURVATURE_RULE,
    descriptionKey: ruleDescriptionKey(CURVATURE_RULE),
    appliesTo: [kinds.curvature],
    check(run) {
      const value = run.valueOf(run.document.id);
      reportErrorList(run, { by: VALIDATE_CURVATURE_MAP }, validateCurvatureMap(value));
    },
  };
}

/** Все правила движка одним набором — обычная сборка редактора. */
export function engineValidationRules(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): readonly ValidationRule[] {
  return Object.freeze([
    sceneRule(kinds),
    terrainRule(kinds),
    systemRule(kinds),
    manifestRule(kinds),
    curvatureRule(kinds),
  ]);
}
