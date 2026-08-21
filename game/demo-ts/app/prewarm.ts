/**
 * Прогрев презентации до первого появления видов в кадре. Всплеск открытия
 * обзора (FOW-8) — прыжок на клиф — раньше платил внутри одного кадра за всё
 * сразу: загрузку и запекание модели (VAT — десятки миллисекунд), создание
 * батча с его материалами, развёртку документов частиц и компиляцию всех
 * шейдерных программ первым draw'ом. Здесь та же работа выполняется во время
 * загрузки: подсистемы строят батчи и образцы заранее (`prewarm`), а их
 * программы компилируются тёплой сценой — с освещением НАСТОЯЩЕЙ сцены,
 * потому что состав света входит в ключ программы three.
 *
 * Прогрев ничего не меняет в наблюдаемом состоянии: тёплые корни в сцену
 * кадра не входят и возвращаются `finish()`; сорвавшийся прогрев кадр не
 * держит — ленивый путь монтажа с заглушкой (ASSET-4) остаётся как был.
 */
import * as THREE from 'three';
import type { FogSubsystem, ModelsSubsystem, ParticlesSubsystem } from '@game-mvp/render';

export interface PrewarmOptions {
  readonly renderer: THREE.WebGLRenderer;
  /** Настоящая сцена кадра — источник света для компиляции тёплых корней. */
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly models: ModelsSubsystem;
  readonly particles: ParticlesSubsystem;
  readonly fog: FogSubsystem | null;
}

export async function prewarmPresentation(options: PrewarmOptions): Promise<void> {
  const { renderer, scene, camera, models, particles, fog } = options;
  // Оба прогрева ждут исхода загрузки своих ассетов; не доехавшие виды
  // остаются ленивому пути и прогрев не держат.
  const [warm] = await Promise.all([models.prewarm(), particles.prewarm()]);
  const warmScene = new THREE.Scene();
  for (const root of warm.roots) warmScene.add(root);
  try {
    // Заливка тяжёлых текстур (VAT — мегабайты float) на GPU до первого кадра.
    for (const texture of warm.textures) renderer.initTexture(texture);
    // Тёплые корни — с освещением настоящей сцены (третий аргумент).
    await renderer.compileAsync(warmScene, camera, scene);
    // Программы того, что уже в сцене: террейн, свет, батчи частиц прогрева.
    await renderer.compileAsync(scene, camera);
    // Пост-проход тумана — материал его полноэкранного квада (FOW-7).
    if (fog !== null) await renderer.compileAsync(fog.postPass.scene, camera);
  } finally {
    warm.finish();
  }
}
