/**
 * Ход цикла времени суток (`rendering` REND-32) — часы и интерполяция отдельно
 * от источников света: здесь живёт ВРЕМЯ (какая фаза идёт, сколько её прожито,
 * какие значения приходятся на этот кадр), а ставит значения на живые источники
 * подсистема (`subsystems/lighting.ts`). Разделение то же, по какому рядом живёт
 * конфигурация (`config.ts`): числа — данные, сцена — подсистема, механизм — тут.
 *
 * ## Слот фазы, кроссфейд в его хвосте
 *
 * Фаза занимает слот длиной `seconds`, и кроссфейд к следующей фазе длиной
 * `transitionSeconds` приходится на ХВОСТ слота. Отсюда два свойства, которых не
 * дало бы «фаза, а переход сверх неё»: круг суток длится ровно сумму
 * длительностей фаз — четыре фазы по 120 секунд проходят за восемь минут, как
 * сказано сценарием REND-32, — а последний кадр перехода приходится ровно на
 * границу слота, поэтому возврата к первой фазе скачком не бывает.
 *
 * Переход, не оставляющий фазе ни секунды собственного облика, форматом не
 * описан: авторское такое число валидация отвергает адресно (PRES-2), а
 * умолчание до него не дорастает (`config.ts`). Здесь остаётся только последний
 * рубеж — укорочение до слота, чтобы недоигранный кроссфейд не стал скачком.
 *
 * Начало круга — начало ПЕРВОЙ фазы, и в этот момент арена освещена ею точно:
 * приди кроссфейд в голову слота, применение секции (ED-15, REND-32) показывало
 * бы кадр, смешанный с фазой, которой сцена ещё не жила.
 *
 * ## Часы — presentation-время кадра
 *
 * Ход считается по `realDt` — беззнаковым часам главного потока, которым режим
 * мира не указ, а НЕ по `dt`, следующему режиму мира (REND-25). Это осознанное
 * расхождение: длина суток — свойство картинки (REND-32: «часы цикла —
 * presentation-время кадра»; design D2), поэтому ни пауза, ни перемотка, ни
 * замедление времени симуляции круг не отматывают и не растягивают. Состояния
 * симуляции цикл не читает вовсе — инвариант PRES-4 держится тем, что читать
 * здесь нечего.
 *
 * ## Аллокации
 *
 * Фазы раскладываются в готовые `THREE.Color` и числа ОДИН раз, на применении
 * секции (`reset`): разбор `#rrggbb` каждым кадром перехода был бы аллокацией на
 * кадр (REND-26). Снимок кадра — одна переиспользуемая запись, как проба
 * отладки (RDBG-2), и установившаяся фаза не отдаёт даже её.
 */
import * as THREE from 'three';
import type { DebugLightingState } from '../debug/lightingSource.js';
import type { LightingCycleConfig } from './config.js';

/**
 * Фаза, разложенная к кадру: тона — готовые объекты и авторские строки рядом,
 * длительности — числа. Строки нужны отладке (RDBG-2), чтобы дамп не звал
 * `getHexString()` на живом источнике.
 */
interface LightingCyclePhase {
  readonly name: string;
  /** Слот фазы, секунды: держание облика плюс хвостовой кроссфейд. */
  readonly seconds: number;
  /** Длительность кроссфейда в хвосте слота — не длиннее самого слота. */
  readonly fadeSeconds: number;
  /** Авторские тона фазы, `#rrggbb`. */
  readonly ambientHex: string;
  readonly directionalHex: string;
  readonly ambientColor: THREE.Color;
  readonly ambientIntensity: number;
  readonly directionalColor: THREE.Color;
  readonly directionalIntensity: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
  /**
   * Значения необязательных источников фазы (REND-29, REND-32): `null` — источника
   * нет у СТАТИЧЕСКОЙ части секции, и по кругу ходить нечему. Заводить его фазой
   * нельзя — это свойство секции, а не фазы (design D6).
   */
  readonly hemisphere: LightingCyclePhaseHemisphere | null;
  readonly rim: LightingCyclePhaseRim | null;
  /** Направление следующей фазы совпадает с этим — переход не двигает источник. */
  readonly holdsDirection: boolean;
}

/** Тона и интенсивность полусферной подсветки фазы, разложенные к кадру. */
interface LightingCyclePhaseHemisphere {
  readonly skyColor: THREE.Color;
  readonly groundColor: THREE.Color;
  readonly intensity: number;
}

/** Тон, интенсивность и направление контрового источника фазы. */
interface LightingCyclePhaseRim {
  readonly color: THREE.Color;
  readonly intensity: number;
  readonly directionX: number;
  readonly directionY: number;
  readonly directionZ: number;
}

/**
 * Значения света на кадре — переиспользуемая запись (REND-26): цикл переписывает
 * её поля, подсистема ставит их на источники. Интенсивность направленного света
 * СУММАРНАЯ: делит её между ярусами подсистема (REND-30), и доля статики
 * применяется к уже слерпленной сумме — пара светит как один источник на любом
 * кадре перехода.
 */
export interface LightingCycleSample {
  /** Направление сдвинулось этим кадром — кэш статики устарел (design D3). */
  directionMoved: boolean;
  readonly ambientColor: THREE.Color;
  ambientIntensity: number;
  readonly directionalColor: THREE.Color;
  directionalIntensity: number;
  directionX: number;
  directionY: number;
  directionZ: number;
  /**
   * Значимы ли поля полусферной подсветки этой записи (REND-32): `false` —
   * подсветки нет у секции, и трогать источник кадру нечем. Флаг, а не
   * вложенная запись с `undefined`, по той же причине, по какой запись здесь
   * переиспользуется: пересобирать вложенный объект кадром — аллокация на кадр
   * (REND-26).
   */
  hasHemisphere: boolean;
  readonly hemisphereSkyColor: THREE.Color;
  readonly hemisphereGroundColor: THREE.Color;
  hemisphereIntensity: number;
  /** То же для контрового источника (REND-29, REND-32). */
  hasRim: boolean;
  readonly rimColor: THREE.Color;
  rimIntensity: number;
  rimDirectionX: number;
  rimDirectionY: number;
  rimDirectionZ: number;
}

/** Цикла нет — общий пустой список, а не свежий на каждое применение секции. */
const NO_PHASES: readonly LightingCyclePhase[] = Object.freeze([]);

/** Линейная доля между двумя числами — тот же lerp, что у `Color.lerpColors`. */
function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Фазы конфигурации в разложенный к кадру вид (см. заголовок про аллокации). */
function prepare(config: LightingCycleConfig): readonly LightingCyclePhase[] {
  const phases = config.phases;
  return phases.map((phase, index) => {
    const next = phases[index + 1 === phases.length ? 0 : index + 1]!;
    return {
      name: phase.name,
      seconds: phase.seconds,
      // Последний рубеж, а не политика: переход длиннее слота доигран не будет,
      // и недоигранный кроссфейд стал бы скачком на границе фаз. Документ с
      // таким переходом валидация отвергает адресно (PRES-2), а умолчание до
      // такой длины не дорастает (`config.ts`), поэтому сюда доходит только
      // подсистема, которой конфигурацию собрали руками, — и ей отдаётся
      // предсказуемое поведение: фаза целиком под кроссфейдом, без скачка.
      fadeSeconds: Math.min(config.transitionSeconds, phase.seconds),
      ambientHex: phase.ambientColor,
      directionalHex: phase.directionalColor,
      ambientColor: new THREE.Color(phase.ambientColor),
      ambientIntensity: phase.ambientIntensity,
      directionalColor: new THREE.Color(phase.directionalColor),
      directionalIntensity: phase.directionalIntensity,
      directionX: phase.directionX,
      directionY: phase.directionY,
      directionZ: phase.directionZ,
      // Тона необязательных источников — тем же порядком, что тона основных:
      // разбор `#rrggbb` один раз на применение секции, а не на кадр перехода
      // (см. заголовок про аллокации).
      hemisphere:
        phase.hemisphere === undefined
          ? null
          : {
              skyColor: new THREE.Color(phase.hemisphere.skyColor),
              groundColor: new THREE.Color(phase.hemisphere.groundColor),
              intensity: phase.hemisphere.intensity,
            },
      rim:
        phase.rim === undefined
          ? null
          : {
              color: new THREE.Color(phase.rim.color),
              intensity: phase.rim.intensity,
              directionX: phase.rim.directionX,
              directionY: phase.rim.directionY,
              directionZ: phase.rim.directionZ,
            },
      // Сравниваются АВТОРСКИЕ компоненты направления: та же тройка — тот же
      // источник в той же точке, и кэш статики на переходе цел (design D3).
      holdsDirection:
        phase.directionX === next.directionX &&
        phase.directionY === next.directionY &&
        phase.directionZ === next.directionZ,
    };
  });
}

/**
 * Цикл времени суток: фазы, часы кадра и снимок значений (REND-32). Один
 * экземпляр живёт у подсистемы освещения всю её жизнь, а применение секции
 * (`reset`) начинает круг заново — других входов у хода цикла нет.
 */
export class LightingCycle {
  private phases: readonly LightingCyclePhase[] = NO_PHASES;
  /** Длина круга, секунды: сумма слотов фаз. */
  private total = 0;
  private index = 0;
  /** Прожито слотом ТЕКУЩЕЙ фазы, секунды. */
  private elapsed = 0;
  /** Прогресс кроссфейда [0, 1); вне перехода — 0. */
  private fade = 0;
  private transition = false;
  /** Значения текущей фазы уже стоят на источниках — кадру делать нечего. */
  private applied = false;
  private readonly out: LightingCycleSample = {
    directionMoved: false,
    ambientColor: new THREE.Color(),
    ambientIntensity: 0,
    directionalColor: new THREE.Color(),
    directionalIntensity: 0,
    directionX: 0,
    directionY: 0,
    directionZ: 0,
    hasHemisphere: false,
    hemisphereSkyColor: new THREE.Color(),
    hemisphereGroundColor: new THREE.Color(),
    hemisphereIntensity: 0,
    hasRim: false,
    rimColor: new THREE.Color(),
    rimIntensity: 0,
    rimDirectionX: 0,
    rimDirectionY: 0,
    rimDirectionZ: 0,
  };

  /** Идёт кроссфейд к следующей фазе — от этого зависит политика теней (D3). */
  get inTransition(): boolean {
    return this.transition;
  }

  /**
   * Состояние круга — в запись отладки (RDBG-2, design D5). Живёт здесь по той
   * же причине, по которой здесь живут часы: номер фазы, её авторское имя и доли
   * прожитого — данные цикла, и знает их только он.
   *
   * Тона фазы едут СВОИМИ полями и не подменяют собой тон действующей
   * конфигурации: на кадре перехода источники покрашены смесью двух фаз, и назови
   * мы этой смесью авторский тон одной из них — дамп говорил бы о кадре
   * неправду. Точный тон кадра не называет никто: снять его можно только
   * `getHexString()` с живого источника, то есть аллокацией строки на кадр
   * (REND-26), а прочесть смесь читателю дампа дают доля перехода и тона обеих
   * фаз.
   */
  fillDebug(out: DebugLightingState): void {
    const phase = this.phases[this.index];
    out.cyclePhases = this.phases.length;
    out.cyclePhaseIndex = phase === undefined ? -1 : this.index;
    out.cyclePhaseName = phase?.name ?? '';
    out.cyclePhaseAmbientColor = phase?.ambientHex ?? '';
    out.cyclePhaseDirectionalColor = phase?.directionalHex ?? '';
    out.cyclePhaseSeconds = phase?.seconds ?? 0;
    out.cyclePhaseProgress = phase === undefined ? 0 : this.elapsed / phase.seconds;
    out.cycleTransition = this.transition;
    out.cycleTransitionSeconds = phase?.fadeSeconds ?? 0;
    out.cycleTransitionProgress = this.fade;
  }

  /**
   * Применение секции (инициализация, правка в рантайме ED-15, потолок пресета,
   * смена сетки): круг начинается с начала ПЕРВОЙ фазы (REND-32). Возвращает
   * значения этой фазы — их подсистема ставит сразу, чтобы сцена с циклом не
   * показала ни одного кадра статической частью секции.
   */
  reset(config: LightingCycleConfig | undefined): LightingCycleSample | null {
    this.phases = config === undefined ? NO_PHASES : prepare(config);
    this.total = this.phases.reduce((sum, phase) => sum + phase.seconds, 0);
    this.index = 0;
    this.elapsed = 0;
    this.fade = 0;
    this.transition = false;
    this.applied = false;
    const first = this.phases[0];
    return first === undefined ? null : this.settle(first);
  }

  /**
   * Кадр цикла по presentation-часам. Возвращает значения, которые надо
   * поставить на источники, либо `null` — цикла нет вовсе или фаза
   * установившаяся и значения на источниках уже её (два сравнения, design D2).
   */
  step(realDt: number): LightingCycleSample | null {
    const phases = this.phases;
    if (phases.length === 0) return null;
    // Кадр без хода времени (пауза кадровых часов, нечисловое значение) цикл не
    // двигает и назад не отматывает: круг суток идёт вперёд или стоит.
    if (Number.isFinite(realDt) && realDt > 0) this.elapsed += realDt;
    // Кадр после долгой паузы (скрытая вкладка) не обходит фазы столько раз,
    // сколько их прошло: круг периодичен, и остаток даёт ту же его точку.
    if (this.elapsed >= this.total) this.elapsed %= this.total;
    let phase = phases[this.index]!;
    while (this.elapsed >= phase.seconds) {
      this.elapsed -= phase.seconds;
      this.index = this.index + 1 === phases.length ? 0 : this.index + 1;
      phase = phases[this.index]!;
      this.applied = false;
    }
    const hold = phase.seconds - phase.fadeSeconds;
    if (this.elapsed < hold) {
      this.transition = false;
      this.fade = 0;
      return this.applied ? null : this.settle(phase);
    }
    this.transition = true;
    this.fade = (this.elapsed - hold) / phase.fadeSeconds;
    const next = phases[this.index + 1 === phases.length ? 0 : this.index + 1]!;
    return this.blend(phase, next, this.fade);
  }

  /** Установившаяся фаза: её значения точно, без остатка кроссфейда. */
  private settle(phase: LightingCyclePhase): LightingCycleSample {
    const out = this.out;
    this.applied = true;
    out.ambientColor.copy(phase.ambientColor);
    out.ambientIntensity = phase.ambientIntensity;
    out.directionalColor.copy(phase.directionalColor);
    out.directionalIntensity = phase.directionalIntensity;
    const hemisphere = phase.hemisphere;
    out.hasHemisphere = hemisphere !== null;
    if (hemisphere !== null) {
      out.hemisphereSkyColor.copy(hemisphere.skyColor);
      out.hemisphereGroundColor.copy(hemisphere.groundColor);
      out.hemisphereIntensity = hemisphere.intensity;
    }
    const rim = phase.rim;
    out.hasRim = rim !== null;
    if (rim !== null) {
      out.rimColor.copy(rim.color);
      out.rimIntensity = rim.intensity;
      out.rimDirectionX = rim.directionX;
      out.rimDirectionY = rim.directionY;
      out.rimDirectionZ = rim.directionZ;
    }
    // Кроссфейд кончается не ровно на границе кадра, и кэш статики остался печён
    // под чуть отличным направлением: установившаяся фаза добивает его один раз.
    // Тем же сравнением ловится и переход нулевой длины — там источник
    // переставляется скачком, и молчать о нём значило бы оставить тень от
    // прежней фазы (REND-32: оторвавшаяся от света тень MUST NOT наблюдаться).
    out.directionMoved =
      out.directionX !== phase.directionX ||
      out.directionY !== phase.directionY ||
      out.directionZ !== phase.directionZ;
    out.directionX = phase.directionX;
    out.directionY = phase.directionY;
    out.directionZ = phase.directionZ;
    return out;
  }

  /** Кадр перехода: доля `t` пути от фазы к фазе на живых значениях. */
  private blend(from: LightingCyclePhase, to: LightingCyclePhase, t: number): LightingCycleSample {
    const out = this.out;
    this.applied = false;
    out.ambientColor.lerpColors(from.ambientColor, to.ambientColor, t);
    out.ambientIntensity = mix(from.ambientIntensity, to.ambientIntensity, t);
    out.directionalColor.lerpColors(from.directionalColor, to.directionalColor, t);
    out.directionalIntensity = mix(from.directionalIntensity, to.directionalIntensity, t);
    // Необязательные источники смешиваются НАРАВНЕ с рассеянным и направленным
    // (REND-32): наличие источника одинаково у всех фаз круга — оно свойство
    // секции, — поэтому парность `from`/`to` здесь гарантирована построением.
    const fromHemisphere = from.hemisphere;
    const toHemisphere = to.hemisphere;
    out.hasHemisphere = fromHemisphere !== null && toHemisphere !== null;
    if (fromHemisphere !== null && toHemisphere !== null) {
      out.hemisphereSkyColor.lerpColors(fromHemisphere.skyColor, toHemisphere.skyColor, t);
      out.hemisphereGroundColor.lerpColors(fromHemisphere.groundColor, toHemisphere.groundColor, t);
      out.hemisphereIntensity = mix(fromHemisphere.intensity, toHemisphere.intensity, t);
    }
    const fromRim = from.rim;
    const toRim = to.rim;
    out.hasRim = fromRim !== null && toRim !== null;
    if (fromRim !== null && toRim !== null) {
      out.rimColor.lerpColors(fromRim.color, toRim.color, t);
      out.rimIntensity = mix(fromRim.intensity, toRim.intensity, t);
      out.rimDirectionX = mix(fromRim.directionX, toRim.directionX, t);
      out.rimDirectionY = mix(fromRim.directionY, toRim.directionY, t);
      out.rimDirectionZ = mix(fromRim.directionZ, toRim.directionZ, t);
    }
    if (from.holdsDirection) {
      // Направления соседних фаз равны: источник стоит, карта глубины от тона не
      // зависит — переход бесплатен для теней при любой длине (design D3).
      out.directionX = from.directionX;
      out.directionY = from.directionY;
      out.directionZ = from.directionZ;
      out.directionMoved = false;
      return out;
    }
    out.directionX = mix(from.directionX, to.directionX, t);
    out.directionY = mix(from.directionY, to.directionY, t);
    out.directionZ = mix(from.directionZ, to.directionZ, t);
    out.directionMoved = true;
    return out;
  }
}
