/**
 * Окружение сцены (REND-29): фон кадра и карта, которой окружение освещает
 * PBR-материалы. Механика three, отделённая от РЕШЕНИЯ подсистемы — та же
 * граница, что у карт теней (`lighting/shadowMaps.ts`).
 *
 * ## Одна текстура на оба применения
 *
 * Вертикальный градиент пишется в маленькую РАВНОПРОМЕЖУТОЧНУЮ текстуру, и её
 * же читают оба потребителя: `scene.background` (three превращает её в
 * кубическую карту) и `scene.environment` (three строит из неё PMREM). Своей
 * генерации ни того, ни другого здесь нет и не будет — производные объекты
 * принадлежат рендереру и уходят вместе с исходной текстурой, которой владеем мы
 * (REND-31).
 *
 * Плоский фон текстуры не заводит вовсе: `scene.background` принимает цвет, и
 * сцена с плоским фоном стоит ровно столько, сколько стоил жёстко зашитый тон в
 * коде приложения — то есть ничего.
 *
 * ## Мир Z-вверх
 *
 * Равнопромежуточная карта у three ориентирована на +Y, а мир арены — Z-вверх
 * (`camera.up = (0, 0, 1)`), поэтому фон и окружение поворачиваются на +90° по
 * X: без поворота градиент шёл бы вдоль горизонта, а не от земли к небу.
 */
import * as THREE from 'three';
import { own } from '../footprint.js';
import type { EnvironmentConfig, HemisphereConfig } from './config.js';

/**
 * Высота равнопромежуточной текстуры градиента. Шестьдесят четыре ряда — предел
 * различимости плавного перехода двух тонов: ниже видны ступени на зените, выше
 * не добавляется ничего, а PMREM всё равно свернёт её в свои мипы.
 */
const GRADIENT_HEIGHT = 64;

/**
 * Ширина: градиент вертикальный, и по долготе в нём ничего не меняется. Четыре
 * столбца, а не один, — чтобы билинейная фильтрация на швах не тянула значение
 * из-за края текстуры.
 */
const GRADIENT_WIDTH = 4;

/** Поворот равнопромежуточной карты под мир Z-вверх (см. заголовок). */
const UP_AXIS_ROTATION = new THREE.Euler(Math.PI / 2, 0, 0);

/** Сцена, какой её видит окружение: ровно три поля three, и ни одного больше. */
export interface EnvironmentScene {
  background: THREE.Color | THREE.Texture | null;
  environment: THREE.Texture | null;
  environmentIntensity: number;
  backgroundRotation: THREE.Euler;
  environmentRotation: THREE.Euler;
}

/**
 * Тона, из которых строится окружение (REND-29): тона ФОНА, а нет их — тона
 * полусферной подсветки. Нет и её — освещать окружением нечем, и авторская
 * интенсивность не действует ни на один материал.
 */
function environmentTones(
  config: EnvironmentConfig,
  hemisphere: HemisphereConfig | undefined,
): { readonly top: string; readonly bottom: string } | null {
  const top = config.backgroundTop;
  const bottom = config.backgroundBottom;
  if (top !== undefined && bottom !== undefined) return { top, bottom };
  if (hemisphere === undefined) return null;
  return { top: hemisphere.skyColor, bottom: hemisphere.groundColor };
}

export class SceneEnvironment {
  /** Текстура градиента; `null` — её не требуется ни фону, ни окружению. */
  private texture: THREE.DataTexture | null = null;
  /** Тона, которыми построена живая текстура: правка тех же — не событие. */
  private tones = '';
  /** Ставила ли подсистема фон: снимать чужой она не вправе. */
  private painted = false;

  /** Живая текстура градиента — вход тестов и учёта ресурсов (REND-31). */
  get gradient(): THREE.DataTexture | null {
    return this.texture;
  }

  /**
   * Применение подсекции к сцене (REND-29, ED-15). Нет подсекции — ни фона, ни
   * окружения: сцена возвращается к тому кадру, каким рисовалась до неё.
   */
  apply(
    scene: EnvironmentScene | undefined,
    config: EnvironmentConfig | undefined,
    hemisphere: HemisphereConfig | undefined,
  ): void {
    if (scene === undefined) return;
    if (config === undefined) {
      this.clear(scene);
      return;
    }
    const tones = environmentTones(config, hemisphere);
    const needsTexture =
      (config.backgroundTop !== undefined && !config.backgroundFlat) ||
      (config.intensity > 0 && tones !== null);
    const texture = needsTexture && tones !== null ? this.ensureGradient(tones) : null;
    if (texture === null) this.release();
    this.paintBackground(scene, config, texture);

    // Окружение: интенсивность без тонов не действует — строить карту не из
    // чего, и объявлять её нулевой значило бы пересобирать программы всех
    // материалов сцены ради «ничего» (REND-29).
    const lit = config.intensity > 0 && texture !== null;
    scene.environment = lit ? texture : null;
    scene.environmentIntensity = lit ? config.intensity : 1;
    if (lit) scene.environmentRotation.copy(UP_AXIS_ROTATION);
  }

  /**
   * Фон кадра: плоский тон — цветом, градиент — текстурой, ничего не написано —
   * фона нет вовсе. Снимается он только СВОЙ (`painted`): фон, поставленный не
   * подсистемой, ей не принадлежит.
   */
  private paintBackground(
    scene: EnvironmentScene,
    config: EnvironmentConfig,
    texture: THREE.DataTexture | null,
  ): void {
    if (config.backgroundFlat && config.backgroundTop !== undefined) {
      scene.background = new THREE.Color(config.backgroundTop);
      this.painted = true;
      return;
    }
    if (config.backgroundTop !== undefined && texture !== null) {
      scene.background = texture;
      scene.backgroundRotation.copy(UP_AXIS_ROTATION);
      this.painted = true;
      return;
    }
    if (!this.painted) return;
    scene.background = null;
    this.painted = false;
  }

  /** Снос (REND-31): текстура градиента и снятый со сцены фон с окружением. */
  dispose(scene?: EnvironmentScene): void {
    if (scene !== undefined) this.clear(scene);
    this.release();
  }

  /** Сцена без окружения — ровно то состояние, в каком её застала подсистема. */
  private clear(scene: EnvironmentScene): void {
    if (this.painted) {
      scene.background = null;
      this.painted = false;
    }
    scene.environment = null;
    scene.environmentIntensity = 1;
    this.release();
  }

  private release(): void {
    this.texture?.dispose();
    this.texture = null;
    this.tones = '';
  }

  /**
   * Текстура вертикального градиента. Тона смешиваются в ЛИНЕЙНОМ пространстве
   * (`Color.lerpColors`), а в байты кладутся кодированными в sRGB — тем же
   * переносом, каким автор их и написал: у текстуры объявлено `SRGBColorSpace`,
   * и GL раскодирует её обратно на выборке.
   */
  private ensureGradient(tones: { readonly top: string; readonly bottom: string }): THREE.DataTexture {
    const key = `${tones.top}|${tones.bottom}`;
    const existing = this.texture;
    if (existing !== null && this.tones === key) return existing;
    this.release();
    const top = new THREE.Color(tones.top);
    const bottom = new THREE.Color(tones.bottom);
    const mixed = new THREE.Color();
    const data = new Uint8Array(GRADIENT_WIDTH * GRADIENT_HEIGHT * 4);
    for (let row = 0; row < GRADIENT_HEIGHT; row++) {
      // Нулевой ряд равнопромежуточной карты — НИЗ: полюс «земли».
      mixed.lerpColors(bottom, top, row / (GRADIENT_HEIGHT - 1));
      const hex = mixed.getHex(THREE.SRGBColorSpace);
      for (let column = 0; column < GRADIENT_WIDTH; column++) {
        const at = (row * GRADIENT_WIDTH + column) * 4;
        data[at] = (hex >> 16) & 0xff;
        data[at + 1] = (hex >> 8) & 0xff;
        data[at + 2] = hex & 0xff;
        data[at + 3] = 255;
      }
    }
    const texture = own(
      'texture',
      'lighting',
      new THREE.DataTexture(data, GRADIENT_WIDTH, GRADIENT_HEIGHT, THREE.RGBAFormat),
    );
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.texture = texture;
    this.tones = key;
    return texture;
  }
}
