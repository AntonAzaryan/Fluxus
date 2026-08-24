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
 * Ступеней у моделей две, и вторая — не украшение: угасание (FOW-8) рисует
 * инстанс копией материала с `transparent`, а прозрачность — бит ключа
 * программы three, то есть программа у копии ДРУГАЯ; и она, и непрозрачная
 * нужны с текстурами скина, которых у первой ступени ещё нет. Порядок здесь
 * тот же, что у их входов: сперва компилируется всё, чему хватает моделей, и
 * только потом — образцы под якорями. Застрявшая текстура (ASSET-4) тогда
 * стоит нам прогрева угасания, а не прогрева батчей и VAT-текстур.
 *
 * Материалы, которыми нарисована вторая ступень, подсистема моделей держит
 * живыми до сноса (её якоря прогрева), и это страховка: пока такой материал
 * жив, `usedTimes` его программы не падает до нуля — программа переживает
 * освобождение любой копии эпизода и в кадре не пересобирается.
 *
 * Прогрев ничего не меняет в наблюдаемом состоянии: тёплые корни в сцену
 * кадра не входят и возвращаются `finish()`; сорвавшийся прогрев кадр не
 * держит — ленивый путь монтажа с заглушкой (ASSET-4) остаётся как был.
 */
import * as THREE from 'three';
import type { FogSubsystem, ModelsSubsystem, ParticlesSubsystem } from '@fluxus/render';

export interface PrewarmOptions {
  readonly renderer: THREE.WebGLRenderer;
  /** Настоящая сцена кадра — источник света для компиляции тёплых корней. */
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly models: ModelsSubsystem;
  readonly particles: ParticlesSubsystem;
  readonly fog: FogSubsystem | null;
}

/**
 * Компилирует сцену под ОБЕ цели, в которые кадр рисует мир, — промежуточную
 * цель тумана и канвас.
 *
 * Цель кадра входит в ключ программы three и в её GLSL, причём дважды:
 * `outputColorSpace` (`WebGLPrograms.getParameters` — при связанной цели это
 * `ColorManagement.workingColorSpace`, то есть `LinearTransferOETF`, а на
 * канвасе `renderer.outputColorSpace`, то есть `sRGBTransferOETF`) и
 * `toneMapping` (при связанной цели — `NoToneMapping`). Компилируй мы только на
 * канвасе, каждая прогретая программа оказалась бы ДУБЛИКАТОМ, которого кадр не
 * рисует ни разу, а настоящие собирались бы в кадре: непрозрачные — в первые
 * секунды матча, прозрачные — на первом же прыжке на клиф. Ровно это и мерилось
 * — кадр 238 мс с двумя ожиданиями линковки по 95–147 мс.
 *
 * Целей именно две, потому что кадр с туманом ходит обоими путями: пока маска
 * ещё строится порциями (FOW-11), мир рисуется прямо на канвас, а как построена
 * — в промежуточную цель (FOW-7, `FogSubsystem.render`). Прогреть одну значило
 * бы перенести компиляцию на другую.
 *
 * Цель берётся СВОЯ, а не та, которой рисует туман: настоящей к этому моменту
 * ещё не существует (она заводится первым кадром по размеру буфера, а при
 * активной цепочке пост-обработки принадлежит вовсе не туману), а ключу
 * программы всё равно, какая цель связана, — важно лишь, что она есть: обе
 * ветки `getParameters` смотрят на `renderer.getRenderTarget() === null`, а не
 * на саму цель. Размер тоже безразличен, поэтому цель здесь 1×1.
 */
async function compileForFrameTargets(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget | null,
  scene: THREE.Scene,
  camera: THREE.Camera,
  lights: THREE.Scene,
): Promise<void> {
  if (target !== null) {
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(target);
      await renderer.compileAsync(scene, camera, lights);
    } finally {
      renderer.setRenderTarget(previous);
    }
  }
  await renderer.compileAsync(scene, camera, lights);
}

export async function prewarmPresentation(options: PrewarmOptions): Promise<void> {
  const { renderer, scene, camera, models, particles, fog } = options;
  // Оба прогрева ждут исхода загрузки своих ассетов; не доехавшие виды
  // остаются ленивому пути и прогрев не держат.
  const [warm] = await Promise.all([models.prewarm(), particles.prewarm()]);
  const warmScene = new THREE.Scene();
  for (const root of warm.roots) warmScene.add(root);
  // Без тумана мир рисуется прямо на канвас, и второй цели у кадра нет.
  const worldTarget = fog === null ? null : new THREE.WebGLRenderTarget(1, 1);
  try {
    // Заливка тяжёлых текстур (VAT — мегабайты float) на GPU до первого кадра.
    for (const texture of warm.textures) renderer.initTexture(texture);
    // Тёплые корни — с освещением настоящей сцены (третий аргумент).
    await compileForFrameTargets(renderer, worldTarget, warmScene, camera, scene);
    // Программы того, что уже в сцене: террейн, свет, батчи частиц прогрева.
    await compileForFrameTargets(renderer, worldTarget, scene, camera, scene);
    // Пост-проход тумана — материал его полноэкранного квада (FOW-7). Он и есть
    // тот, кто рисует НА КАНВАС, поэтому цель кадра ему подставлять нельзя.
    if (fog !== null) await renderer.compileAsync(fog.postPass.scene, camera);
    // Вторая ступень моделей — образцы под якорями (FOW-8). Ждёт своих текстур
    // скина и потому идёт ПОСЛЕ всего, чему хватило моделей: уже прогретое
    // застрявшая текстура у нас не отнимет. Компилируется той же тёплой сценой
    // — прежние корни в ней дают попадания в кэш программ, а не работу.
    for (const root of await warm.anchoredRoots()) warmScene.add(root);
    await compileForFrameTargets(renderer, worldTarget, warmScene, camera, scene);
  } finally {
    // Цель прогрева больше не нужна: программы держат материалы, а не она —
    // у three ключ материала помнит ВСЕ его программы (`materialProperties.
    // programs`), и обе доживут до сноса материала, а не до сноса этой цели.
    worldTarget?.dispose();
    warm.finish();
  }
}
