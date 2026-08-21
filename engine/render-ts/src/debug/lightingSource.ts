/**
 * Отладочный источник освещения сцены (`lighting.scene`, RDBG-1) — объявляет
 * его подсистема освещения в точке своей регистрации (REND-27).
 *
 * ## Что он показывает
 *
 * Свет, которым нарисован кадр, и решение теневого прохода: сколько источников
 * подсистема держит в сцене и каких, как поделена между ними интенсивность
 * (REND-30), какой режим теней ДЕЙСТВУЕТ против авторского и потолка пресета
 * (QUAL-1) — и чья теневая карта рисуется прямо сейчас. Последнее и есть ответ
 * на «почему тень декорации кадром старше»: в `hybrid` кадр перерисовки кэша
 * статики пропускает обновление динамической карты, и это единственное
 * наблюдаемое следствие механизма.
 *
 * Авторское значение и потолок стоят в пробе рядом с действующим по образцу
 * источника маски тумана (FOW-10): видно, что сцена просит `full`, а тени
 * рисуются `none`, и это пресет, а не потерянное поле документа. Отдельным
 * полем названо и то, объявил ли парный документ секцию `lighting` вовсе
 * (PRES-2): «умолчания» и «автор написал ровно умолчания» — разные ответы на
 * вопрос «где искать эти числа».
 *
 * ## Границы
 *
 * Данные — то, что подсистема уже держит: значения действующей конфигурации,
 * живые объекты источников и её собственный реестр кастеров. Своей работы
 * источник не заказывает и счётчиков стоимости не двигает (RDBG-8) — суммарную
 * интенсивность он складывает у себя, а не просит посчитать подсистему.
 *
 * Вырезанному фильтром снапшота (RDBG-6) здесь взяться неоткуда по построению:
 * свет — presentation-данные парного документа (PRES-4), одни и те же у всех, а
 * ярусы кастеров считают КОРНИ нарисованного, то есть ровно то, что уже в кадре.
 *
 * Часовые величины есть ровно у цикла времени суток (REND-32) и ровно тогда,
 * когда цикл в секции есть: доли прожитого фазой и переходом выведены из
 * кадровых часов и уезжают в секцию `clock` (RDBG-7). Всё остальное от часов не
 * зависит вовсе — свет сцены без цикла не зависит ни от тика, ни от часов
 * главного потока, — поэтому два дампа на одном доставленном состоянии
 * совпадают. Перечней нет: источников света на арене единицы, а ярусы кастеров
 * описаны числами — ограничивать потолком (RDBG-7) здесь нечего.
 */
import type { ShadowMode } from '../lighting/config.js';
import type { ShadowPhase } from '../types.js';
import type { DebugColor, DebugDraw, DebugProbe, DebugSource } from './contract.js';

/**
 * Тон отметки источника — цвет отладочного слоя, а не тон самого света: рисуй
 * отметку авторским цветом, и «где стоит источник» смешалось бы с «каким он
 * светит». Тон света живёт в дампе (RDBG-7).
 */
const LIGHT_COLOR: DebugColor = 0xffe066;

/**
 * Состояние освещения на кадре — плоская запись, которую заполняет подсистема.
 * Запись ОДНА и переиспользуется между кадрами (RDBG-2): свежая на кадр была бы
 * мусором ради данных, которые дамп всё равно копирует.
 */
export interface DebugLightingState {
  /** Подсистема отдана сцене (`init`); false — источников света в кадре нет. */
  inScene: boolean;
  /** Парный документ объявил секцию `lighting` (PRES-2); false — умолчания. */
  authoredSection: boolean;
  /** Рассеянных источников в сцене (REND-29). */
  ambientLights: number;
  /** Направленных источников: 1 либо 2 — пара ярусов режима `hybrid` (REND-30). */
  directionalLights: number;
  /** Тон и интенсивность рассеянного источника. */
  ambientColor: string;
  ambientIntensity: number;
  /** Тон направленного источника — общий у пары. */
  directionalColor: string;
  /** Интенсивность источника кэшированной карты статики (в `hybrid` — доля). */
  sunIntensity: number;
  /** Интенсивность источника покадровой карты; 0 — пары в сцене нет. */
  sunDynamicIntensity: number;
  /** Позиция направленного источника, мировые единицы; пара стоит в одной точке. */
  lightWorldX: number;
  lightWorldY: number;
  lightWorldZ: number;
  /** Цель источника — центр арены, по которому обтянут фрустум теневой камеры. */
  targetWorldX: number;
  targetWorldY: number;
  targetWorldZ: number;
  /** Радиус арены, мировые единицы; по нему считаны позиция и фрустум. */
  arenaRadiusWorldUnits: number;
  /** Полусторона ортографического фрустума теневой камеры, мировые единицы. */
  shadowFrustumHalfWorldUnits: number;
  /** Действующий режим теней, авторский режим секции и потолок пресета (QUAL-1). */
  shadowMode: ShadowMode;
  authoredShadowMode: ShadowMode;
  /** Потолок режима; `full` — потолка нет: самый дорогой и есть «не ограничивать». */
  ceilingShadowMode: ShadowMode;
  /** Сторона карты теней в текселях: действующая (у камеры источника) и авторская. */
  shadowMapTexels: number;
  authoredShadowMapTexels: number;
  /** Потолок стороны карты; бесконечность — потолка нет. */
  ceilingShadowMapTexels: number;
  /** Доля интенсивности, отданная кэшированной карте статики в `hybrid`. */
  staticShare: number;
  /** Чья карта рисуется этим кадром и, значит, чьи кастеры подняты флагом. */
  shadowPhase: ShadowPhase;
  /** Корней-кастеров в реестре ярусов (REND-30) — корней, а не мешей. */
  staticCasterRoots: number;
  dynamicCasterRoots: number;
  /** Перерисовок кэшированной карты статики с создания подсистемы. */
  staticRebuilds: number;
  /** Кэш статики устарел: ближайший кадр перерисует его. */
  staticStale: boolean;
  /** Карт теней, ПОСТРОЕННЫХ теневым проходом; 0 — прохода ещё не было. */
  builtShadowMaps: number;
  /** Фаз в цикле времени суток (REND-32); 0 — подсекции цикла в секции нет. */
  cyclePhases: number;
  /** Номер текущей фазы с нуля; -1 — цикла нет. */
  cyclePhaseIndex: number;
  /** Авторское имя текущей фазы; пусто — имени автор не дал. */
  cyclePhaseName: string;
  /** Слот текущей фазы, секунды: держание облика плюс хвостовой кроссфейд. */
  cyclePhaseSeconds: number;
  /** Доля прожитого слотом текущей фазы, [0, 1) — часовая величина (RDBG-7). */
  cyclePhaseProgress: number;
  /** Идёт кроссфейд к следующей фазе. */
  cycleTransition: boolean;
  /** Длительность кроссфейда текущей фазы, секунды. */
  cycleTransitionSeconds: number;
  /** Прогресс кроссфейда, [0, 1); вне перехода — 0 — часовая величина (RDBG-7). */
  cycleTransitionProgress: number;
}

export interface DebugLightingProbe extends DebugProbe {
  /** Единицы величин прозой рядом с ними (RDBG-7). */
  readonly units: string;
  readonly authoredSection: boolean;
  /** Источников света у подсистемы в сцене: рассеянные плюс направленные. */
  readonly lightCount: number;
  readonly ambientLights: number;
  readonly directionalLights: number;
  readonly ambientColor: string;
  readonly ambientIntensity: number;
  readonly directionalColor: string;
  /** Суммарная интенсивность направленных источников кадра — до деления. */
  readonly directionalIntensity: number;
  readonly sunIntensity: number;
  readonly sunDynamicIntensity: number;
  readonly lightWorldX: number;
  readonly lightWorldY: number;
  readonly lightWorldZ: number;
  readonly targetWorldX: number;
  readonly targetWorldY: number;
  readonly targetWorldZ: number;
  readonly arenaRadiusWorldUnits: number;
  readonly shadowFrustumHalfWorldUnits: number;
  readonly shadowMode: ShadowMode;
  readonly authoredShadowMode: ShadowMode;
  /** Потолок режима; `full` — потолка нет (QUAL-1). */
  readonly ceilingShadowMode: ShadowMode;
  readonly shadowMapTexels: number;
  readonly authoredShadowMapTexels: number;
  /** Потолок стороны карты, тексели; null — потолка нет. */
  readonly ceilingShadowMapTexels: number | null;
  readonly staticShare: number;
  /** Фаза теневого прохода: `none`, `static`, `dynamic`, `full`. */
  readonly shadowPhase: ShadowPhase;
  readonly staticCasterRoots: number;
  readonly dynamicCasterRoots: number;
  readonly staticRebuilds: number;
  readonly staticStale: boolean;
  readonly builtShadowMaps: number;
  /** Цикл времени суток (REND-32): фаз в нём, номер и имя текущей, длительности. */
  readonly cyclePhases: number;
  readonly cyclePhaseIndex: number;
  readonly cyclePhaseName: string;
  readonly cyclePhaseSeconds: number;
  readonly cycleTransition: boolean;
  readonly cycleTransitionSeconds: number;
}

/** Что источнику нужно от подсистемы освещения — снимок её кадрового решения. */
export interface LightingDebugAccess {
  /**
   * Состояние освещения этого кадра в переданную запись. Подсистема заполняет
   * ту же запись каждый кадр (RDBG-2) и отдаёт ТО, чем нарисован кадр: позиции
   * и интенсивности берутся с живых источников сцены, а не считаются вторично.
   */
  state(out: DebugLightingState): void;
}

export function lightingSceneDebugSource(
  access: LightingDebugAccess,
): DebugSource<DebugLightingProbe> {
  const state: DebugLightingState = {
    inScene: false,
    authoredSection: false,
    ambientLights: 0,
    directionalLights: 0,
    ambientColor: '',
    ambientIntensity: 0,
    directionalColor: '',
    sunIntensity: 0,
    sunDynamicIntensity: 0,
    lightWorldX: 0,
    lightWorldY: 0,
    lightWorldZ: 0,
    targetWorldX: 0,
    targetWorldY: 0,
    targetWorldZ: 0,
    arenaRadiusWorldUnits: 0,
    shadowFrustumHalfWorldUnits: 0,
    shadowMode: 'none',
    authoredShadowMode: 'none',
    ceilingShadowMode: 'full',
    shadowMapTexels: 0,
    authoredShadowMapTexels: 0,
    ceilingShadowMapTexels: Number.POSITIVE_INFINITY,
    staticShare: 0,
    shadowPhase: 'none',
    staticCasterRoots: 0,
    dynamicCasterRoots: 0,
    staticRebuilds: 0,
    staticStale: false,
    builtShadowMaps: 0,
    cyclePhases: 0,
    cyclePhaseIndex: -1,
    cyclePhaseName: '',
    cyclePhaseSeconds: 0,
    cyclePhaseProgress: 0,
    cycleTransition: false,
    cycleTransitionSeconds: 0,
    cycleTransitionProgress: 0,
  };
  /**
   * Часовые величины цикла (RDBG-7): доли, выведенные из кадровых часов, уезжают
   * в отдельную секцию дампа — воспроизводимыми они не бывают, и смешанные с
   * остальными они превратили бы всякий дифф в шум. Запись переиспользуется, как
   * и сама проба, и приезжает в пробу ТОЛЬКО когда цикл в секции есть: сцене без
   * цикла часовых величин взять неоткуда.
   */
  const cycleClock = { cyclePhaseProgress: 0, cycleTransitionProgress: 0 };
  // Переиспользуемая проба (RDBG-2): поля переписываются, объект живёт.
  const probe = {
    units:
      'lightWorld*, targetWorld*, arenaRadiusWorldUnits и shadowFrustumHalfWorldUnits — ' +
      'мировые единицы; shadowMapTexels — сторона карты теней в текселях; ' +
      'интенсивности безразмерны; staticShare — доля [0..1]; casterRoots — КОРНИ ' +
      'поддеревьев реестра, а не меши; staticRebuilds — перерисовки кэша, не тики; ' +
      'cyclePhaseSeconds и cycleTransitionSeconds — секунды кадровых часов, ' +
      'cyclePhaseProgress и cycleTransitionProgress — доли [0..1) в секции clock',
    authoredSection: false,
    lightCount: 0,
    ambientLights: 0,
    directionalLights: 0,
    ambientColor: '',
    ambientIntensity: 0,
    directionalColor: '',
    directionalIntensity: 0,
    sunIntensity: 0,
    sunDynamicIntensity: 0,
    lightWorldX: 0,
    lightWorldY: 0,
    lightWorldZ: 0,
    targetWorldX: 0,
    targetWorldY: 0,
    targetWorldZ: 0,
    arenaRadiusWorldUnits: 0,
    shadowFrustumHalfWorldUnits: 0,
    shadowMode: 'none' as ShadowMode,
    authoredShadowMode: 'none' as ShadowMode,
    ceilingShadowMode: 'full' as ShadowMode,
    shadowMapTexels: 0,
    authoredShadowMapTexels: 0,
    ceilingShadowMapTexels: null as number | null,
    staticShare: 0,
    shadowPhase: 'none' as ShadowPhase,
    staticCasterRoots: 0,
    dynamicCasterRoots: 0,
    staticRebuilds: 0,
    staticStale: false,
    builtShadowMaps: 0,
    cyclePhases: 0,
    cyclePhaseIndex: -1,
    cyclePhaseName: '',
    cyclePhaseSeconds: 0,
    cycleTransition: false,
    cycleTransitionSeconds: 0,
    clock: undefined as Readonly<Record<string, number>> | undefined,
    noData: undefined as string | undefined,
  };

  return {
    id: 'lighting.scene',
    title: 'освещение сцены: источники, режим теней и ярусы кастеров',
    probe(): DebugLightingProbe {
      access.state(state);
      if (!state.inScene) {
        probe.noData =
          'подсистема освещения ещё не отдана сцене: источников света в кадре нет (REND-29)';
        probe.clock = undefined;
        return probe;
      }
      probe.noData = undefined;
      probe.authoredSection = state.authoredSection;
      probe.ambientLights = state.ambientLights;
      probe.directionalLights = state.directionalLights;
      probe.lightCount = state.ambientLights + state.directionalLights;
      probe.ambientColor = state.ambientColor;
      probe.ambientIntensity = state.ambientIntensity;
      probe.directionalColor = state.directionalColor;
      probe.sunIntensity = state.sunIntensity;
      probe.sunDynamicIntensity = state.sunDynamicIntensity;
      // Сумму складывает отладка у себя: заказывать ради пробы работу подсистемы
      // ей нельзя (RDBG-8), а два слагаемых она уже назвала.
      probe.directionalIntensity = state.sunIntensity + state.sunDynamicIntensity;
      probe.lightWorldX = state.lightWorldX;
      probe.lightWorldY = state.lightWorldY;
      probe.lightWorldZ = state.lightWorldZ;
      probe.targetWorldX = state.targetWorldX;
      probe.targetWorldY = state.targetWorldY;
      probe.targetWorldZ = state.targetWorldZ;
      probe.arenaRadiusWorldUnits = state.arenaRadiusWorldUnits;
      probe.shadowFrustumHalfWorldUnits = state.shadowFrustumHalfWorldUnits;
      probe.shadowMode = state.shadowMode;
      probe.authoredShadowMode = state.authoredShadowMode;
      probe.ceilingShadowMode = state.ceilingShadowMode;
      probe.shadowMapTexels = state.shadowMapTexels;
      probe.authoredShadowMapTexels = state.authoredShadowMapTexels;
      // «Потолка нет» выражается null, а не бесконечностью: числом дампа она не
      // бывает, и читатель принял бы её за разрешение (RDBG-7).
      probe.ceilingShadowMapTexels = Number.isFinite(state.ceilingShadowMapTexels)
        ? state.ceilingShadowMapTexels
        : null;
      probe.staticShare = state.staticShare;
      probe.shadowPhase = state.shadowPhase;
      probe.staticCasterRoots = state.staticCasterRoots;
      probe.dynamicCasterRoots = state.dynamicCasterRoots;
      probe.staticRebuilds = state.staticRebuilds;
      probe.staticStale = state.staticStale;
      probe.builtShadowMaps = state.builtShadowMaps;
      probe.cyclePhases = state.cyclePhases;
      probe.cyclePhaseIndex = state.cyclePhaseIndex;
      probe.cyclePhaseName = state.cyclePhaseName;
      probe.cyclePhaseSeconds = state.cyclePhaseSeconds;
      probe.cycleTransition = state.cycleTransition;
      probe.cycleTransitionSeconds = state.cycleTransitionSeconds;
      if (state.cyclePhases === 0) {
        // Цикла в секции нет — часовых величин у источника нет ни одной, и
        // пустая секция `clock` их не заменяет (RDBG-7).
        probe.clock = undefined;
      } else {
        cycleClock.cyclePhaseProgress = state.cyclePhaseProgress;
        cycleClock.cycleTransitionProgress = state.cycleTransitionProgress;
        probe.clock = cycleClock;
      }
      return probe;
    },
    draw(value: DebugLightingProbe, out: DebugDraw): void {
      // Отметка стоит там, где подсистема поставила направленный источник, —
      // в кадре его не видно ничем, а от его позиции зависит и направление
      // теней, и то, что вообще попало во фрустум теневой камеры.
      const x = value.lightWorldX;
      const y = value.lightWorldY;
      const z = value.lightWorldZ;
      out.point(x, y, z, LIGHT_COLOR);
      // Отметка ОДНА и в режиме `hybrid`: пара источников стоит в одной точке и
      // светит одинаково по построению, и вторая метка легла бы в первую.
      // Луч на цель — центр арены: по нему читается направление света.
      out.segment(x, y, z, value.targetWorldX, value.targetWorldY, value.targetWorldZ, LIGHT_COLOR);
      // Рассеянный источник позиции не имеет вовсе и живёт только в дампе:
      // рисовать его негде, а выдумывать ему точку значило бы показывать то,
      // чего в сцене нет (RDBG-6).
    },
  };
}
