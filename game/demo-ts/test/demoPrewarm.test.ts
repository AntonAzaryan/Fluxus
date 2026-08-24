/**
 * Прогрев презентации демо (`app/prewarm.ts`) — политика игры, а не движок:
 * подсистемы отдают, ЧТО прогревать (`ModelsPrewarm`), а КОГДА и ПОД КАКУЮ
 * ЦЕЛЬ КАДРА это компилировать, решает сборка.
 *
 * Проверяется здесь ровно то, что живого GL для проверки не требует: порядок
 * ступеней и цель, связанная на момент каждой компиляции. Сами программы, их
 * ключи и время линковки — дело драйвера, и меряются они стендом (PERF-7), а
 * не тестом; но какая цель связана, полностью определяет две ветки ключа у
 * three (`outputColorSpace` и `toneMapping`), и вот это — наблюдаемо и
 * фиксируется.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { FogSubsystem, ModelsPrewarm, ModelsSubsystem, ParticlesSubsystem } from '@game-mvp/render';
import { prewarmPresentation } from '../app/prewarm.js';

/** Что и подо что компилировалось: имя сцены и вид связанной цели кадра. */
interface CompileRecord {
  readonly scene: string;
  readonly target: 'канвас' | 'цель кадра';
}

function makeRig(withFog: boolean): {
  compiles: CompileRecord[];
  run: () => Promise<void>;
  anchored: THREE.Object3D;
} {
  const compiles: CompileRecord[] = [];
  const scene = new THREE.Scene();
  scene.name = 'сцена кадра';
  const warmRoot = new THREE.Object3D();
  const anchored = new THREE.Object3D();
  const postScene = new THREE.Scene();
  postScene.name = 'пост-проход';

  let current: THREE.WebGLRenderTarget | null = null;
  const renderer = {
    initTexture: () => {},
    getRenderTarget: () => current,
    setRenderTarget: (target: THREE.WebGLRenderTarget | null) => {
      current = target;
    },
    compileAsync: (target: THREE.Object3D) => {
      compiles.push({
        // Тёплая сцена своего имени не несёт — узнаём её по составу.
        scene: target === scene ? 'сцена кадра' : target === postScene ? 'пост-проход' : 'тёплая сцена',
        target: current === null ? 'канвас' : 'цель кадра',
      });
      return Promise.resolve(target);
    },
  } as unknown as THREE.WebGLRenderer;

  const warm: ModelsPrewarm = {
    roots: [warmRoot],
    textures: [],
    anchoredRoots: () => Promise.resolve([anchored]),
    finish: () => {},
  };
  const models = { prewarm: () => Promise.resolve(warm) } as unknown as ModelsSubsystem;
  const particles = { prewarm: () => Promise.resolve() } as unknown as ParticlesSubsystem;
  const fog = withFog ? ({ postPass: { scene: postScene } } as unknown as FogSubsystem) : null;

  return {
    compiles,
    anchored,
    run: () => prewarmPresentation({ renderer, scene, camera: new THREE.Camera(), models, particles, fog }),
  };
}

describe('прогрев демо компилируется под цель кадра (FOW-7, FOW-8)', () => {
  it('с туманом греется КАЖДЫЙ вариант: и в цель кадра, и на канвас', async () => {
    const rig = makeRig(true);
    await rig.run();

    // Мир рисуется обоими путями: пока маска строится порциями (FOW-11) — прямо
    // на канвас, как построена — в промежуточную цель (FOW-7). Цель кадра
    // входит в ключ программы дважды (`outputColorSpace`, `toneMapping`), так
    // что прогрев одного пути оставил бы компиляцию другого в кадре — ровно тот
    // стук на первом прыжке, ради которого прогрев и заведён.
    expect(rig.compiles).toEqual([
      { scene: 'тёплая сцена', target: 'цель кадра' },
      { scene: 'тёплая сцена', target: 'канвас' },
      { scene: 'сцена кадра', target: 'цель кадра' },
      { scene: 'сцена кадра', target: 'канвас' },
      // Пост-проход тумана САМ рисует на канвас — цели кадра ему не подставляют.
      { scene: 'пост-проход', target: 'канвас' },
      // Вторая ступень (образцы под якорями) — теми же двумя целями.
      { scene: 'тёплая сцена', target: 'цель кадра' },
      { scene: 'тёплая сцена', target: 'канвас' },
    ]);
  });

  it('вторая ступень входит в ту же тёплую сцену и компилируется после первой', async () => {
    const rig = makeRig(true);
    await rig.run();
    // Корни якорей доехали в тёплую сцену — иначе их программы никто бы не собрал.
    expect(rig.anchored.parent).not.toBeNull();
    const warmCompiles = rig.compiles.filter((record) => record.scene === 'тёплая сцена');
    expect(warmCompiles.length).toBe(4); // две ступени × две цели кадра
  });

  it('без тумана цель кадра одна — канвас: мир рисуется прямо в него', async () => {
    const rig = makeRig(false);
    await rig.run();
    expect(rig.compiles.every((record) => record.target === 'канвас')).toBe(true);
    expect(rig.compiles).toHaveLength(3); // тёплая, сцена кадра, вторая ступень
  });
});
