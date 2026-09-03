/**
 * Необязательные источники секции `lighting` (`rendering` REND-29): полусферная
 * подсветка (hemisphere) и контровой источник (rim). Живут отдельно от
 * подсистемы (`subsystems/lighting.ts`) тем же швом, что пул локальных
 * источников (`localLights.ts`): подсистема решает КОГДА применять, а здесь —
 * что именно применяется и на каких объектах three.
 *
 * ## «Нет подсекции — нет источника»
 *
 * Правило одно на оба источника и исполняется здесь: источник живёт в сцене
 * ровно пока конфигурация его несёт. Держать его выключенным с нулевой
 * интенсивностью было бы вторым способом записать «нет», и сцена без подсекции
 * перестала бы рисоваться байт-в-байт как прежде — источник всё равно занимает
 * место в униформах материалов сцены (design D1).
 *
 * Смена наличия — СОБЫТИЕ (правка секции, ED-15), и пересборка программ
 * материалов на ней допустима; кадром такого не бывает: фаза цикла (REND-32)
 * меняет только числа, а завести источник фазой формат не позволяет.
 *
 * ## Стоимость
 *
 * Ни карт, ни проходов, ни обхода инстансов ни один из двух не порождает:
 * покадровая стоимость обоих константна относительно контента сцены (QUAL-3), и
 * собственных GPU-ресурсов у них нет — снос сводится к снятию со сцены (REND-31).
 */
import * as THREE from 'three';
import type { HemisphereConfig, RimConfig } from './config.js';
import { aimDirectional, type ArenaExtent } from './arena.js';

/**
 * Значения обоих источников на кадре — то, что ставит цикл времени суток.
 *
 * Флаги `has*` — часть контракта записи: они говорят, ЗНАЧИМЫ ЛИ её поля на этом
 * кадре. Проверяются они наравне с присутствием источника в сцене, а не вместо
 * него: сегодня две проверки совпадают (наличие у фазы выводится из статической
 * части секции, `resolvePhase`), но совпадают они по построению конфигурации, а
 * не по контракту записи, — и разойдясь однажды, они положили бы на живой
 * источник нули незаполненной записи.
 */
export interface OptionalLightValues {
  /** Значимы ли поля полусферной подсветки этой записи (REND-32). */
  readonly hasHemisphere: boolean;
  /** Значимы ли поля контрового источника этой записи (REND-32). */
  readonly hasRim: boolean;
  readonly hemisphereSkyColor: THREE.Color;
  readonly hemisphereGroundColor: THREE.Color;
  readonly hemisphereIntensity: number;
  readonly rimColor: THREE.Color;
  readonly rimIntensity: number;
  readonly rimDirectionX: number;
  readonly rimDirectionY: number;
  readonly rimDirectionZ: number;
}

export class OptionalLights {
  /**
   * Полусферная подсветка (REND-29): объём без теней — верх приёмника тонирован
   * цветом «неба», низ цветом «земли», смешение идёт по нормали поверхности.
   */
  readonly hemisphere = new THREE.HemisphereLight();
  /**
   * Контровой источник (REND-29): второй направленный свет, отделяющий силуэты
   * от фона. Теней он не отбрасывает никогда и в реестр кастеров не входит —
   * карты теней принадлежат главному источнику (REND-30).
   */
  readonly rim = new THREE.DirectionalLight();

  constructor() {
    this.hemisphere.name = 'lighting:hemisphere';
    // Ось «небо → земля» three выводит из МИРОВОЙ ПОЗИЦИИ источника
    // (`WebGLLights`: `direction.setFromMatrixPosition(light.matrixWorld)`), а
    // отдельного поля направления у него нет. Конструктор three ставит туда
    // `Object3D.DEFAULT_UP` = (0, 1, 0), а сцена здесь Z-up (REND-1): без этой
    // строки «небом» красились бы стены, обращённые к +Y, «землёй» — к −Y, а
    // всё горизонтальное получало бы смесь поровну — ровно обратное сценарию
    // REND-29. Позиция полусферного источника — это НАПРАВЛЕНИЕ и только оно:
    // от расстояния его вклад не зависит, поэтому единичного вектора хватает.
    this.hemisphere.position.set(0, 0, 1);
    this.rim.name = 'lighting:rim';
    // Флаг теней снимается на самом источнике: три проверяет его здесь, и
    // другого места у контрового света нет.
    this.rim.castShadow = false;
  }

  /** Подсветка в сцене — вход дампа отладки и тестов (RDBG-7). */
  get hemisphereLit(): boolean {
    return this.hemisphere.parent !== null;
  }

  /** Контровой источник в сцене — тем же порядком. */
  get rimLit(): boolean {
    return this.rim.parent !== null;
  }

  /**
   * Значения секции под потолками пресета: числа — на источники, наличие — в
   * состав сцены. Сцена не задана (подсистема ещё не получила `init`) — числа
   * ставятся всё равно, а состав сцены сложит ближайшее применение после `init`.
   */
  apply(
    scene: THREE.Object3D | undefined,
    extent: ArenaExtent,
    hemisphere: HemisphereConfig | undefined,
    rim: RimConfig | undefined,
  ): void {
    if (hemisphere !== undefined) {
      this.hemisphere.color.set(hemisphere.skyColor);
      this.hemisphere.groundColor.set(hemisphere.groundColor);
      this.hemisphere.intensity = hemisphere.intensity;
    }
    if (rim !== undefined) {
      this.rim.color.set(rim.color);
      this.rim.intensity = rim.intensity;
      aimDirectional(this.rim, extent, rim.directionX, rim.directionY, rim.directionZ);
    }
    if (scene === undefined) return;
    if (hemisphere !== undefined && !this.hemisphereLit) scene.add(this.hemisphere);
    else if (hemisphere === undefined && this.hemisphereLit) this.hemisphere.removeFromParent();
    if (rim !== undefined && !this.rimLit) {
      scene.add(this.rim);
      // Цель направленного источника — объект сцены: без неё матрица цели не
      // обновляется, и направление считалось бы от мирового нуля.
      scene.add(this.rim.target);
    } else if (rim === undefined && this.rimLit) {
      this.rim.removeFromParent();
      this.rim.target.removeFromParent();
    }
  }

  /**
   * Значения кадра цикла времени суток (REND-32) — на ЖИВЫЕ источники. Наличие
   * источника здесь не трогается ни в какую сторону: оно свойство статической
   * части секции, и фаза меняет только числа (design D6).
   *
   * Обе проверки — и флаг записи, и присутствие источника в сцене — обязательны:
   * первая говорит, есть ли у ЭТОГО КАДРА что ставить, вторая — есть ли КУДА.
   */
  applySample(values: OptionalLightValues, extent: ArenaExtent): void {
    if (values.hasHemisphere && this.hemisphereLit) {
      this.hemisphere.color.copy(values.hemisphereSkyColor);
      this.hemisphere.groundColor.copy(values.hemisphereGroundColor);
      this.hemisphere.intensity = values.hemisphereIntensity;
    }
    if (!values.hasRim || !this.rimLit) return;
    this.rim.color.copy(values.rimColor);
    this.rim.intensity = values.rimIntensity;
    aimDirectional(
      this.rim,
      extent,
      values.rimDirectionX,
      values.rimDirectionY,
      values.rimDirectionZ,
    );
  }

  /** Снос (REND-31): своих GPU-ресурсов нет — оба уходят со сцены, и только. */
  dispose(): void {
    this.hemisphere.removeFromParent();
    this.rim.removeFromParent();
    this.rim.target.removeFromParent();
  }
}
