/**
 * Исполнитель прогрева демо (`app/prewarm.ts`) и раннеры стадий старта
 * (`app/boot/bootStages.ts`) — политика игры, а не движок: подсистемы отдают,
 * ЧТО прогревать (`SubsystemPrewarm`, REND-45), а КОГДА и ПОД КАКУЮ ЦЕЛЬ КАДРА
 * это компилировать, решает сборка (`game-boot` BOOT-3).
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
import {
  EMPTY_PREWARM_BATCH,
  prewarmBatch,
  type PrewarmBatch,
  type SubsystemPrewarm,
} from '@fluxus/render';
import {
  compileForFrameTargets,
  createPrewarmQueue,
  prewarmSubsystem,
  type PrewarmRenderer,
  type PrewarmSubsystem,
  type PrewarmTargets,
} from '../app/prewarm.js';
import { createStageRunners, startBootStages } from '../app/boot/bootStages.js';
import { DEFAULT_BOOT_DOCUMENT, type BootDocument } from '../app/boot/bootDocument.js';

/** Что и подо что компилировалось: имя сцены и вид связанной цели кадра. */
interface CompileRecord {
  readonly scene: string;
  readonly target: 'канвас' | 'цель кадра';
}

/** Стенд компиляции: рендерер-шпион, сцена кадра и цель тумана 1×1. */
interface Rig {
  compiles: CompileRecord[];
  targets: PrewarmTargets;
  scene: THREE.Scene;
  postScene: THREE.Scene;
  initialized: THREE.Texture[];
  /** Связанная цель кадра СЕЙЧАС — состояние одного рендерера на все стадии. */
  readonly bound: 'канвас' | 'цель кадра';
}

/**
 * `slow: true` — `compileAsync` разрешается макротаском, как настоящая линковка
 * программы: только так видно, что делают со связанной целью кадра стадии,
 * идущие параллельно.
 */
function makeRig(withFog: boolean, options: { readonly slow?: boolean } = {}): Rig {
  const compiles: CompileRecord[] = [];
  const initialized: THREE.Texture[] = [];
  const scene = new THREE.Scene();
  scene.name = 'сцена кадра';
  const postScene = new THREE.Scene();
  postScene.name = 'пост-проход';

  let current: THREE.WebGLRenderTarget | null = null;
  const renderer: PrewarmRenderer = {
    initTexture: (texture) => {
      initialized.push(texture);
    },
    setRenderTarget: (target) => {
      current = target;
    },
    compileAsync: (target) => {
      compiles.push({
        // Тёплая сцена своего имени не несёт — узнаём её по составу.
        scene: target === scene ? 'сцена кадра' : target === postScene ? 'пост-проход' : 'тёплая сцена',
        target: current === null ? 'канвас' : 'цель кадра',
      });
      return options.slow === true
        ? new Promise((resolve) => {
            setTimeout(() => {
              resolve(target);
            }, 0);
          })
        : Promise.resolve(target);
    },
  };
  return {
    compiles,
    scene,
    postScene,
    initialized,
    get bound(): 'канвас' | 'цель кадра' {
      return current === null ? 'канвас' : 'цель кадра';
    },
    targets: {
      renderer,
      scene,
      camera: new THREE.Camera(),
      worldTarget: withFog ? new THREE.WebGLRenderTarget(1, 1) : null,
      queue: createPrewarmQueue(),
    },
  };
}

/** Подсистема-фикстура с двумя ступенями: у моделей форма именно такая. */
function twoStage(
  name: string,
  first: THREE.Object3D,
  settled: THREE.Object3D,
  finished: string[] = [],
): PrewarmSubsystem {
  return {
    name,
    prewarm: () =>
      Promise.resolve({
        first: prewarmBatch({ roots: [first] }),
        settled: Promise.resolve(prewarmBatch({ roots: [settled] })),
        finish: () => finished.push(name),
      }),
  };
}

describe('прогрев демо компилируется под цель кадра (FOW-7, FOW-8, REND-45)', () => {
  it('с туманом греется КАЖДЫЙ вариант: и в цель кадра, и на канвас', async () => {
    const rig = makeRig(true);
    const first = new THREE.Object3D();
    const settled = new THREE.Object3D();
    await prewarmSubsystem(twoStage('models', first, settled), rig.targets).done;

    // Мир рисуется обоими путями: пока маска строится порциями (FOW-11) — прямо
    // на канвас, как построена — в промежуточную цель (FOW-7). Цель кадра
    // входит в ключ программы дважды (`outputColorSpace`, `toneMapping`), так
    // что прогрев одного пути оставил бы компиляцию другого в кадре — ровно тот
    // стук на первом прыжке, ради которого прогрев и заведён.
    expect(rig.compiles).toEqual([
      { scene: 'тёплая сцена', target: 'цель кадра' },
      { scene: 'тёплая сцена', target: 'канвас' },
      // Вторая ступень (образцы под якорями) — теми же двумя целями.
      { scene: 'тёплая сцена', target: 'цель кадра' },
      { scene: 'тёплая сцена', target: 'канвас' },
    ]);
    // Обе ступени вошли в ОДНУ тёплую сцену: повторные корни второй ступени
    // дают попадание в кэш программ three, а не работу.
    expect(first.parent).not.toBeNull();
    expect(settled.parent).toBe(first.parent);
  });

  it('без тумана цель кадра одна — канвас: мир рисуется прямо в него', async () => {
    const rig = makeRig(false);
    await prewarmSubsystem(
      twoStage('models', new THREE.Object3D(), new THREE.Object3D()),
      rig.targets,
    ).done;
    expect(rig.compiles.every((record) => record.target === 'канвас')).toBe(true);
    expect(rig.compiles).toHaveLength(2); // по ступени на каждую компиляцию
  });

  it('экранный корень компилируется НА КАНВАС даже при цели кадра (FOW-7)', async () => {
    // Пост-проход тумана сам рисует на канвас, и подставлять ему цель кадра
    // значило бы собрать программу, которой не нарисован ни один кадр.
    const rig = makeRig(true);
    const fog: PrewarmSubsystem = {
      name: 'fog',
      prewarm: () =>
        Promise.resolve({
          first: prewarmBatch({ screenRoots: [rig.postScene] }),
          settled: Promise.resolve(EMPTY_PREWARM_BATCH),
          finish: () => undefined,
        }),
    };
    await prewarmSubsystem(fog, rig.targets).done;
    expect(rig.compiles).toEqual([{ scene: 'пост-проход', target: 'канвас' }]);
  });

  it('пустая ступень не компилирует ничего, а текстуры заливаются всегда', async () => {
    const rig = makeRig(true);
    const texture = new THREE.Texture();
    const particles: PrewarmSubsystem = {
      name: 'particles',
      prewarm: () =>
        Promise.resolve({
          first: prewarmBatch({ textures: [texture] }),
          settled: Promise.resolve(prewarmBatch({ textures: [texture] })),
          finish: () => undefined,
        }),
    };
    await prewarmSubsystem(particles, rig.targets).done;
    // Компилировать нечего: корней подсистема не отдала вовсе, и лишний
    // `compileAsync` по неизменившейся тёплой сцене был бы работой ради формы.
    expect(rig.compiles).toEqual([]);
    // А заливка на GPU идёт обеими ступенями — она и есть работа частиц.
    expect(rig.initialized).toEqual([texture, texture]);
  });

  it('`finish` зовётся и при отказе ступени: тёплое возвращается владельцу', async () => {
    const rig = makeRig(true);
    const finished: string[] = [];
    const broken: PrewarmSubsystem = {
      name: 'models',
      prewarm: () =>
        Promise.resolve<SubsystemPrewarm>({
          first: prewarmBatch({ roots: [new THREE.Object3D()] }),
          settled: Promise.reject(new Error('текстура скина не доехала')),
          finish: () => finished.push('models'),
        }),
    };
    await expect(prewarmSubsystem(broken, rig.targets).done).rejects.toThrow('текстура скина');
    // Прогрев сорвался, тёплые объекты вернулись: `finish` стоит в `finally`
    // именно за этим (REND-45).
    expect(finished).toEqual(['models']);
  });
});

describe('стадии идут параллельно, а связанная цель кадра одна на всех (REND-45)', () => {
  it('каждая канвасная компиляция видит КАНВАС, а не чужую цель кадра', async () => {
    // Стадии стартуют разом (`startBootStages`), а связанная цель кадра —
    // состояние ОДНОГО рендерера: стадия, уснувшая на линковке со связанной
    // целью, отдала бы её соседке, и та скомпилировала бы «канвасный» вариант
    // под чужой целью — дубликат, которого кадр не рисует ни разу, при том что
    // настоящая программа осталась бы первому кадру.
    const rig = makeRig(true, { slow: true });
    const stages = [
      twoStage('models', new THREE.Object3D(), new THREE.Object3D()),
      twoStage('effects', new THREE.Object3D(), new THREE.Object3D()),
      {
        name: 'fog',
        prewarm: () =>
          Promise.resolve({
            first: prewarmBatch({ screenRoots: [rig.postScene] }),
            settled: Promise.resolve(EMPTY_PREWARM_BATCH),
            finish: () => undefined,
          }),
      },
    ];
    await Promise.all([
      ...stages.map((stage) => prewarmSubsystem(stage, rig.targets).done),
      // Стадия сцены кадра идёт тем же прогоном и той же очередью.
      compileForFrameTargets(rig.targets.scene, rig.targets),
    ]);

    // Каждый мировой батч прогрет ОБОИМИ путями кадра, и ровно по разу.
    const world = rig.compiles.filter((record) => record.scene !== 'пост-проход');
    expect(world.filter((record) => record.target === 'цель кадра')).toHaveLength(world.length / 2);
    expect(world.filter((record) => record.target === 'канвас')).toHaveLength(world.length / 2);
    // Пост-проход рисует на канвас сам (FOW-7) — чужой цели под ним не бывает.
    expect(rig.compiles.filter((record) => record.scene === 'пост-проход')).toEqual([
      { scene: 'пост-проход', target: 'канвас' },
    ]);
    // И за собой прогрев оставляет канвас: кадр начинает работу с него.
    expect(rig.bound).toBe('канвас');
  });

  it('отказ одной стадии очередь не рвёт: соседка компилируется как ни в чём не бывало', async () => {
    const rig = makeRig(true, { slow: true });
    const broken: PrewarmSubsystem = {
      name: 'models',
      prewarm: () =>
        Promise.resolve<SubsystemPrewarm>({
          first: prewarmBatch({ roots: [new THREE.Object3D()] }),
          settled: Promise.reject(new Error('не доехало')),
          finish: () => undefined,
        }),
    };
    const good = twoStage('effects', new THREE.Object3D(), new THREE.Object3D());
    const [first, second] = await Promise.allSettled([
      prewarmSubsystem(broken, rig.targets).done,
      prewarmSubsystem(good, rig.targets).done,
    ]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect(rig.compiles.filter((record) => record.target === 'канвас').length).toBeGreaterThan(0);
    expect(rig.bound).toBe('канвас');
  });
});

describe('сворачивание стадии по таймауту (BOOT-4, REND-45)', () => {
  it('`abandon` возвращает тёплое владельцу, не дожидаясь второй ступени', async () => {
    // Вторая ступень ждёт текстур скина, которые вправе не приехать никогда
    // (ASSET-4) — ровно тот случай, ради которого у стадии есть таймаут. Сам
    // таймаут только ставит исход; вернуть тёплое обязано сворачивание, иначе
    // батч-группа с уже привязавшейся живой записью осталась бы вне сцены кадра.
    const rig = makeRig(true);
    const finished: string[] = [];
    let release: (batch: PrewarmBatch) => void = () => undefined;
    const stuck: PrewarmSubsystem = {
      name: 'models',
      prewarm: () =>
        Promise.resolve<SubsystemPrewarm>({
          first: prewarmBatch({ roots: [new THREE.Object3D()] }),
          settled: new Promise((resolve) => {
            release = resolve;
          }),
          finish: () => finished.push('models'),
        }),
    };
    const run = prewarmSubsystem(stuck, rig.targets);
    // Первая ступень успела скомпилироваться — её прогрев таймаут не отменяет.
    await Promise.resolve();
    await Promise.resolve();
    expect(rig.compiles.length).toBeGreaterThan(0);

    run.abandon();
    expect(finished).toEqual(['models']);
    // Идемпотентно: сворачивать вправе и таймаут, и обычный конец стадии.
    run.abandon();
    expect(finished).toEqual(['models']);

    // Доехавшая позже вторая ступень не компилируется вовсе: у свёрнутого
    // прогрева тёплых объектов уже нет (REND-45 требует того же и от `finish`
    // подсистемы — идущая `settled` после него обязана быть no-op).
    const late = new THREE.Object3D();
    release(prewarmBatch({ roots: [late] }));
    await run.done;
    expect(late.parent).toBeNull();
    // И `finish` не зовётся вторым разом: своё стадия вернула на сворачивании.
    expect(finished).toEqual(['models']);
  });

  it('свёрнутая до первой ступени стадия тёплого не строит вовсе', async () => {
    const rig = makeRig(false);
    const finished: string[] = [];
    let build: (warm: SubsystemPrewarm) => void = () => undefined;
    const slow: PrewarmSubsystem = {
      name: 'models',
      prewarm: () =>
        new Promise((resolve) => {
          build = resolve;
        }),
    };
    const run = prewarmSubsystem(slow, rig.targets);
    run.abandon();
    build({
      first: prewarmBatch({ roots: [new THREE.Object3D()] }),
      settled: Promise.resolve(EMPTY_PREWARM_BATCH),
      finish: () => finished.push('models'),
    });
    await run.done;
    // Компилировать было незачем — исход у стадии уже есть, — а тёплое всё
    // равно вернулось владельцу.
    expect(rig.compiles).toEqual([]);
    expect(finished).toEqual(['models']);
  });
});

describe('раннеры стадий старта (`game-boot` BOOT-3, BOOT-4)', () => {
  function documentOf(names: readonly string[]): BootDocument {
    return {
      ...DEFAULT_BOOT_DOCUMENT,
      stages: names.map((name) => ({ name, required: true, timeoutMs: 1000 })),
    };
  }

  it('стадия-событие раннера не получает: её закрывает машина, а не промис', () => {
    const rig = makeRig(false);
    const runners = createStageRunners(
      documentOf(['handshake', 'firstDelivery', 'warmFrames', 'scene']),
      { targets: rig.targets, subsystems: [] },
    );
    expect(runners.map((runner) => runner.name)).toEqual(['scene']);
  });

  it('стадия сцены компилирует НАСТОЯЩУЮ сцену кадра под обе цели', async () => {
    const rig = makeRig(true);
    const runners = createStageRunners(documentOf(['scene']), {
      targets: rig.targets,
      subsystems: [],
    });
    await runners[0]!.run();
    expect(rig.compiles).toEqual([
      { scene: 'сцена кадра', target: 'цель кадра' },
      { scene: 'сцена кадра', target: 'канвас' },
    ]);
  });

  it('названная подсистема, которой на сцене нет, даёт `skipped` (QUAL-1)', () => {
    const rig = makeRig(false);
    const doc = documentOf(['prewarm.fog']);
    const outcomes: [string, string][] = [];
    startBootStages(doc, createStageRunners(doc, { targets: rig.targets, subsystems: [] }), (name, outcome) => {
      outcomes.push([name, outcome]);
    });
    expect(outcomes).toEqual([['prewarm.fog', 'skipped']]);
  });

  it('отказ раннера даёт исход `failed`, а не исключение наружу', async () => {
    const rig = makeRig(false);
    const finished: string[] = [];
    const doc = documentOf(['prewarm.models']);
    const broken: PrewarmSubsystem = {
      name: 'models',
      prewarm: () =>
        Promise.resolve<SubsystemPrewarm>({
          first: prewarmBatch({ roots: [new THREE.Object3D()] }),
          settled: Promise.reject(new Error('не доехало')),
          finish: () => finished.push('models'),
        }),
    };
    const outcomes: [string, string][] = [];
    const warned: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      startBootStages(doc, createStageRunners(doc, { targets: rig.targets, subsystems: [broken] }), (name, outcome) => {
        outcomes.push([name, outcome]);
      });
      // Отказ приезжает исходом стадии — прогрев есть оптимизация, а не условие
      // корректности (BOOT-4): вид смонтируется прежним ленивым путём (ASSET-4).
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      console.warn = warn;
    }
    expect(outcomes).toEqual([['prewarm.models', 'failed']]);
    expect(finished).toEqual(['models']);
    expect(warned).toHaveLength(1);
  });
});
