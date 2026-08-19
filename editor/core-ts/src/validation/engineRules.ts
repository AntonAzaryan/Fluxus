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
 * Код причины у всех пяти один — `REJECTED`: правило ничего не различает само,
 * а различать за чужой валидатор значило бы разбирать его прозу (см. ниже).
 * Строку причины это оставляет одну на правило, и она называет валидатора и
 * везёт его сообщение дословно.
 *
 * Чего эти правила не дают и дать не могут: адреса ВНУТРИ проверяемого для
 * валидаторов ядра. `loadScene`, `createTerrainGrid` и `validateSystem`
 * бросают на первом нарушении и путь не возвращают, поэтому находка адресует
 * проверенное целиком, а место называет дословным сообщением ядра. Это не
 * обход ED-30, а его предел на сегодняшней поверхности ядра: разобрать прозу на
 * путь значило бы завести у себя знание о её формулировках.
 *
 * «Проверенное целиком» — не обязательно документ целиком. Там, где ядру
 * скармливается не документ, а его запись — JSON-система списка `systems`
 * конфига сцены (SER-7), — находка адресует запись: перебор по списку делает
 * редактор, а вердикт по каждой записи по-прежнему выносит ядро. Адрес списка
 * при этом правилу не известен, а приходит параметром (`DocumentSite`) — тем
 * же приёмом, что у междокументных правил, и по той же причине (ED-25).
 *
 * Отсюда же общее правило обёртки: аффорданс может быть производным, вердикт
 * всегда за ядром. Редактор вправе сам решить, ЧТО показать ядру и КУДА
 * привесить его ответ; чем этот ответ будет, он не решает никогда — иначе
 * рядом с правилом ядра завелась бы его вторая реализация (ED-1, CORE-3).
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
import {
  validateCurvatureMap,
  validateManifest,
  validatePresentationScene,
  type CameraConfigDescription,
  type CameraEffectsDescription,
} from '@game-mvp/assets';
import {
  getAtPath,
  isJsonArray,
  isJsonObject,
  type DocumentKind,
  type EditorDocument,
  type JsonPath,
  type JsonValue,
} from '../document/index.js';
import { compareIds } from '../registry/index.js';
import { REJECTED, reportErrorList, reportThrown } from './adapters.js';
// Форма адреса места одна на весь слой валидации — см. «Раскладку документов
// правило не знает» в шапке `crossDocument.ts`. Второй тип с теми же двумя
// полями заявлял бы, что адрес правила движка — что-то иное, чем адрес
// междокументного правила, а это одно и то же знание сборки (ED-25).
import type { DocumentSite } from './crossDocument.js';
import { ruleDescriptionKey } from './reasons.js';
import type { ValidationRule, ValidationRun } from './types.js';

/** Виды редактируемого, на которых стоят правила движка. */
export interface EngineRuleKinds {
  readonly scene: DocumentKind;
  readonly terrain: DocumentKind;
  readonly curvature: DocumentKind;
  readonly manifest: DocumentKind;
  readonly system: DocumentKind;
  /** Парный presentation-документ сцены (`presentation-scene` PRES-1). */
  readonly presentation: DocumentKind;
}

export const DEFAULT_ENGINE_KINDS: EngineRuleKinds = Object.freeze({
  scene: 'scene',
  terrain: 'terrain',
  curvature: 'curvature',
  manifest: 'manifest',
  system: 'system',
  presentation: 'presentation',
});

const EMPTY_PATH: JsonPath = Object.freeze([]);

/**
 * Где лежат JSON-системы (SYS-1). Пустой путь — «документ и есть система»,
 * непустой — «список систем внутри документа-носителя»: у конфига сцены
 * `systems` — поле (SER-7), а не отдельные документы, и правило обязано
 * работать на обеих раскладках, не выбирая между ними само.
 */
export type SystemSite = DocumentSite;

/** Умолчание — система отдельным документом того вида, что назвали виды. */
export const DEFAULT_SYSTEM_SITES: readonly SystemSite[] = Object.freeze([
  Object.freeze({ kind: DEFAULT_ENGINE_KINDS.system, path: EMPTY_PATH }),
]);

function systemSitesOf(kinds: EngineRuleKinds, sites: readonly SystemSite[] | undefined): readonly SystemSite[] {
  // Умолчание считается по видам, а не берётся константой: проект, назвавший
  // вид системы иначе, подаёт свои виды и вправе не подавать адресов.
  return sites ?? [{ kind: kinds.system, path: EMPTY_PATH }];
}

/**
 * Знание, которое правилам приносит сборка, — по тем же основаниям, что виды
 * документов и адреса междокументных правил (`DocumentSite`): раскладку и
 * состав редактируемого знает тот, кто собирает редактор (ED-25).
 *
 * Описание типов эффектов камеры (`camera` CAM-9) импортом сюда прийти не может:
 * пакет headless и от `@game-mvp/render` не зависит — а описание живёт там.
 * Без него секция эффектов проверяется структурно (ASSET-8), с ним — по нему.
 * Ровно теми же основаниями и тем же путём приходит описание конфига камеры
 * (`camera` CAM-1) для секции конфига (ASSET-10).
 */
export interface EngineRuleOptions {
  readonly cameraEffects?: CameraEffectsDescription;
  readonly cameraConfig?: CameraConfigDescription;
}

/** Кто проверял — уезжает в ожидание находки, чтобы вопрос «чьё правило» не гадался. */
export const LOAD_SCENE = '@game-mvp/core:loadScene';
export const CREATE_TERRAIN_GRID = '@game-mvp/core:createTerrainGrid';
export const VALIDATE_SYSTEM = '@game-mvp/core:validateSystem';
export const VALIDATE_MANIFEST = '@game-mvp/assets:validateManifest';
export const VALIDATE_CURVATURE_MAP = '@game-mvp/assets:validateCurvatureMap';
export const VALIDATE_PRESENTATION = '@game-mvp/assets:validatePresentationScene';

export const SCENE_RULE = 'core.scene';
export const TERRAIN_RULE = 'core.terrain';
export const SYSTEM_RULE = 'core.system';
export const MANIFEST_RULE = 'assets.manifest';
export const CURVATURE_RULE = 'assets.curvature';
export const PRESENTATION_RULE = 'assets.presentation';

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
 * Мир сцены, в котором проверяется система. Обычно это мир уже поднятой сцены —
 * второго `loadScene` на ту же правку не появляется.
 *
 * Разбирать стоит только второй случай. Сцена, чей список `systems` содержит
 * сломанную систему, не поднимается ИЗ-ЗА неё: `loadScene` регистрирует
 * системы последними и падает на первой негодной (SYS-3). Мир, в котором эту
 * систему судить, гасит она сама, и находка на её записи была бы недостижима —
 * ровно то состояние, которое сегодня превращает опечатку в одном действии в
 * одно сообщение на весь конфиг.
 *
 * Поэтому при провале полного подъёма мир берётся ещё раз, со списком систем
 * пустым. Это законный мир той же сцены: `validateSystem` читает компоненты и
 * prefabs, а их состав от систем не зависит вовсе — регистрация систем ничего в
 * мир не добавляет. Второй подъём случается только на уже сломанной сцене,
 * кэшируется тем же прогоном и, если сцена сломана не системой, проваливается
 * так же — тогда правило систем молчит, как молчало.
 */
function sceneWorld(run: ValidationRun, document: EditorDocument): Scene['world'] | undefined {
  const loaded = loadedScene(run, document);
  if (loaded.ok) return loaded.scene.world;
  return run.derive(`loadScene(noSystems) ${document.id}`, (): Scene['world'] | undefined => {
    const value = run.valueOf(document.id);
    if (!isJsonObject(value)) return undefined;
    try {
      return loadScene({ ...(value as unknown as SceneDef), systems: [] }).world;
    } catch {
      // О причине отчитывается правило самой сцены; здесь она означает ровно
      // «мира нет», и второго сообщения о ней правило систем не добавляет.
      return undefined;
    }
  });
}

/** Запись системы: её определение и адрес внутри документа-носителя. */
interface SystemRecord {
  readonly def: SystemDef;
  readonly path: JsonPath;
}

function systemRecordsAt(value: JsonValue | undefined, path: JsonPath): readonly SystemRecord[] {
  if (value === undefined) return [];
  if (path.length === 0) return [{ def: value as unknown as SystemDef, path: EMPTY_PATH }];
  const list = getAtPath(value, path);
  // Места нет или оно не список — это не раскладка систем. Форму поля проверяет
  // ядро на документе-носителе (SER-7), и второго сообщения о ней здесь нет.
  if (!isJsonArray(list)) return [];
  return list.map((entry, index) => ({
    def: entry as unknown as SystemDef,
    path: Object.freeze([...path, index]),
  }));
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
    reasonCodes: [REJECTED],
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
    reasonCodes: [REJECTED],
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
 * действий, затем конструктор, проверяющий имя, порядок и форму тела. Ни
 * порядок этих вызовов, ни то, что они проверяют, правилу не известны — оно
 * знает только, кого спросить и куда привесить ответ.
 *
 * Куда привесить — говорят адреса мест: система бывает отдельным документом, а
 * бывает записью списка `systems` конфига сцены (SER-7), и на второй раскладке
 * находка адресует ЗАПИСЬ, а не документ. Это единственное, что перебор по
 * списку добавляет к вердикту ядра, и ровно ради этого он и написан: цикл ED-8
 * работает на уровне системы, а не файла, где систем шесть.
 */
export function systemRule(
  kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS,
  sites?: readonly SystemSite[],
): ValidationRule {
  const places = systemSitesOf(kinds, sites);
  return {
    id: SYSTEM_RULE,
    descriptionKey: ruleDescriptionKey(SYSTEM_RULE),
    reasonCodes: [REJECTED],
    appliesTo: [...new Set(places.map((site) => site.kind))].sort(compareIds),
    check(run) {
      const scenes = run.documentsOfKind(kinds.scene);
      if (scenes.length === 0) return;
      const value = run.valueOf(run.document.id);
      for (const site of places) {
        if (site.kind !== run.document.kind) continue;
        for (const record of systemRecordsAt(value, site.path)) {
          for (const sceneDocument of scenes) {
            const world = sceneWorld(run, sceneDocument);
            // Сцена, мира которой нет, молчит: об этом отчитывается её
            // собственное правило, а система против непостроенного мира не
            // проверяема ничем.
            if (world === undefined) continue;
            reportThrown(
              run,
              { by: VALIDATE_SYSTEM, base: record.path, params: { against: sceneDocument.id } },
              () => {
                validateSystem(record.def, world);
                new EvaluatedSystem(record.def);
              },
            );
          }
        }
      }
    },
  };
}

/** Манифест визуалов (ASSET-6, ASSET-8) — ED-14 требует тех же проверок в реальном времени. */
export function manifestRule(
  kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS,
  options: EngineRuleOptions = {},
): ValidationRule {
  return {
    id: MANIFEST_RULE,
    descriptionKey: ruleDescriptionKey(MANIFEST_RULE),
    reasonCodes: [REJECTED],
    appliesTo: [kinds.manifest],
    check(run) {
      const value = run.valueOf(run.document.id);
      // Описание типов эффектов — вход валидации, а не знание правила (ASSET-8,
      // CAM-9): без него секция проверяется структурно, с ним — по нему, и
      // предупреждения о её записях доезжают до находок важности `warning`.
      // Описание конфига камеры (CAM-1) — тем же путём: без него неизвестный
      // параметр секции конфига (ASSET-10) не подсветился бы в редакторе, хотя
      // у клиента он предупреждение (ED-14 требует тех же проверок).
      reportErrorList(
        run,
        { by: VALIDATE_MANIFEST },
        validateManifest(value, {
          ...(options.cameraEffects === undefined ? {} : { cameraEffects: options.cameraEffects }),
          ...(options.cameraConfig === undefined ? {} : { cameraConfig: options.cameraConfig }),
        }),
      );
    },
  };
}

/** Карта кривизны (ASSET-7) — целые узловые смещения и форма узловой сетки; ED-11 требует их сразу. */
export function curvatureRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: CURVATURE_RULE,
    descriptionKey: ruleDescriptionKey(CURVATURE_RULE),
    reasonCodes: [REJECTED],
    appliesTo: [kinds.curvature],
    check(run) {
      const value = run.valueOf(run.document.id);
      reportErrorList(run, { by: VALIDATE_CURVATURE_MAP }, validateCurvatureMap(value));
    },
  };
}

/**
 * Парный presentation-документ сцены (PRES-2): закрытый состав документа,
 * записи decoration и необязательные секции — конфигурация тумана (FOW-10) и
 * конфигурация освещения. Проверяет их `validatePresentationScene` — тот же
 * вызов, которым документ поднимает загрузчик ассетов (ASSET-3), и второй его
 * реализации в редакторе быть не может (ED-1, CORE-3).
 *
 * Правило нужно ровно затем, зачем правило манифеста: ED-14 требует тех же
 * проверок в реальном времени, а адрес нарушения (`lighting.shadows.mode`,
 * `decorations[3].scale`) едет в находку разбором сообщения (`adapters.ts`) и
 * приводит автора к строке, а не к файлу.
 */
export function presentationRule(kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS): ValidationRule {
  return {
    id: PRESENTATION_RULE,
    descriptionKey: ruleDescriptionKey(PRESENTATION_RULE),
    reasonCodes: [REJECTED],
    appliesTo: [kinds.presentation],
    check(run) {
      const value = run.valueOf(run.document.id);
      reportErrorList(run, { by: VALIDATE_PRESENTATION }, validatePresentationScene(value));
    },
  };
}

/**
 * Все правила движка одним набором — обычная сборка редактора. Адреса систем —
 * последним параметром и по той же причине, по какой адреса расстановки идут
 * последними у междокументных: раскладку знает собирающий редактор (ED-25), а
 * проект, у которого системы лежат отдельными документами, о ней и не
 * заговаривает.
 */
export function engineValidationRules(
  kinds: EngineRuleKinds = DEFAULT_ENGINE_KINDS,
  options: EngineRuleOptions = {},
  systemSites?: readonly SystemSite[],
): readonly ValidationRule[] {
  return Object.freeze([
    sceneRule(kinds),
    terrainRule(kinds),
    systemRule(kinds, systemSites),
    manifestRule(kinds, options),
    curvatureRule(kinds),
    presentationRule(kinds),
  ]);
}
