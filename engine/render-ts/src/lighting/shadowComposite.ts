/**
 * Сведение двух ярусов теней в ОДНУ карту режима `hybrid` (`rendering` REND-30)
 * — механика отдельно от РЕШЕНИЙ подсистемы (`subsystems/lighting.ts`), тем же
 * швом, каким рядом живут пул локальных источников (`localLights.ts`), часы
 * цикла (`cycle.ts`) и карты теней (`shadowMaps.ts`): подсистема знает, чей ярус
 * рисуется в этом кадре, а здесь — как две глубины становятся одной картой.
 *
 * ## Почему сведение, а не два источника
 *
 * Раньше `hybrid` держал ПАРУ направленных источников с одинаковым направлением
 * и делил интенсивность между ними долей `staticShare`: у каждого своя карта,
 * тексель гасился только своей. Отсюда дефект: пол, затенённый одним лишь
 * зданием, получал `I·(1−s)` — тень вполовину светлее, чем в `full`, — а полная
 * тьма приходилась только на пересечение ярусов. Обоснование поля («иначе тень
 * выходила бы вдвое темнее») перевёрнуто: два источника полной силы делают вдвое
 * ярче ОСВЕЩЁННОЕ, а тень темнее не становится.
 *
 * Здесь источник ОДИН и карта одна, а ярусы сводятся ПОЭЛЕМЕНТНЫМ МИНИМУМОМ
 * глубин: ближайший к свету заслон и есть тот, что даёт тень. Затенение в
 * `hybrid` от этого совпадает с `full` в точности, а кэш статики остаётся
 * кэшем — перерисовывается событием, как и был.
 *
 * ## Три цели и один полноэкранный проход
 *
 * - `staticTarget` — кэшированная глубина статического яруса; перерисовывается
 *   событием (REND-30);
 * - `dynamicTarget` — покадровая глубина динамического яруса;
 * - `mapTarget` — та карта, которую three отдаёт материалам сцены
 *   (`light.shadow.map`, а материалы читают её `depthTexture`, `WebGLLights`).
 *
 * Кадр: подсистема просит three нарисовать глубину ЯРУСА этого кадра в его
 * цель — вызовом `renderer.shadowMap.render` с подменённой `shadow.map`, — а
 * затем полноэкранный проход пишет `gl_FragDepth = min(static, dynamic)` в
 * `mapTarget`. Глубину рисует именно three, а не мы: выбор материала глубины —
 * его машинерия (`customDepthMaterial` батчевого яруса REND-20, сторона теней,
 * скиннинг), и второй её реализации быть не должно.
 *
 * ## Проход глубины — изнутри `render()`, а не рядом с ним
 *
 * `shadowMap.render` у `THREE.WebGLRenderer` — не самостоятельный вход: каждый
 * объект прохода идёт через `setProgram`, а тот читает состояние кадра
 * (`currentRenderState`), которое существует только между входом в `render()`
 * и выходом из него. Вызванный снаружи проход падает на первом же кастере
 * (`Cannot read properties of null (reading 'state')`), и живой WebGL этим
 * отличается от двойника тестов, который снимает флаг и ничего не читает.
 * Поэтому проход заказывается КРЮЧКОМ: у поля есть сцена из одного меша,
 * который ничего не рисует (пустая геометрия, ни цвета, ни глубины), а из его
 * `onBeforeRender` — уже внутри `render()` этой сцены — и зовётся теневой
 * проход. Целью `render()` крючка стоит цель самого яруса: её проход всё равно
 * очищает и переписывает, так что снаружи кадр не трогается ничем.
 *
 * ## Порт рендерера
 *
 * Проходы выполняются в кадре ПОДСИСТЕМЫ (до отрисовки сцены потребителем),
 * поэтому рендерер приходит опцией сборки — тем же порядком, каким приходит
 * камера кадра (REND-8: общий объект подсистемам приносит сборка). Нет порта —
 * сведения нет, и подсистема исполняет `hybrid` как `full`: картинка та же,
 * кэша статики нет (см. `subsystems/lighting.ts`).
 */
import * as THREE from 'three';
import { own } from '../footprint.js';
import { uniformOf } from '../uniforms.js';

/**
 * Рендерер глазами теневых проходов — структурный минимум `THREE.WebGLRenderer`
 * (по образцу `PostRendererLike`, REND-34). Кроме отрисовки полноэкранного
 * прохода нужен вход в теневой проход самого three: он один знает, каким
 * материалом считать глубину каждого объекта.
 */
export interface ShadowRendererLike {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  /**
   * Теневая машинерия three. `enabled === false` — потребитель тени выключил
   * вовсе, и заказывать проход бессмысленно.
   */
  readonly shadowMap: {
    readonly enabled: boolean;
    render(lights: readonly THREE.Light[], scene: THREE.Object3D, camera: THREE.Camera): void;
  };
}

/** Ярус, чья глубина рисуется этим кадром (REND-30). */
export type CompositeTier = 'static' | 'dynamic';

/**
 * Цель глубины теневого прохода. Формат повторяет то, что three заводит сам для
 * `PCFShadowMap` (`WebGLShadowMap`): цветная цель плюс текстура глубины
 * `DepthFormat`/`UnsignedIntType`. Различается ОДНО — функция сравнения:
 *
 * - у целей ярусов её нет (`compareFunction === null`): их читает наш
 *   полноэкранный проход обычным `sampler2D`, а с поднятым сравнением текстура
 *   стала бы `sampler2DShadow` и вернула бы не глубину, а результат сравнения;
 * - у карты, которую читают материалы сцены, она есть — на ней и держится
 *   аппаратный PCF three.
 */
function createDepthTarget(size: number, compare: boolean): THREE.WebGLRenderTarget {
  const target = own(
    'renderTarget',
    'lighting',
    new THREE.WebGLRenderTarget(size, size, { depthBuffer: true }),
  );
  const depth = own('texture', 'lighting', new THREE.DepthTexture(size, size));
  depth.format = THREE.DepthFormat;
  depth.type = THREE.UnsignedIntType;
  depth.compareFunction = compare ? THREE.LessEqualCompare : null;
  depth.minFilter = compare ? THREE.LinearFilter : THREE.NearestFilter;
  depth.magFilter = compare ? THREE.LinearFilter : THREE.NearestFilter;
  target.depthTexture = depth;
  target.texture.name = compare ? 'lighting:shadow-map' : 'lighting:shadow-tier';
  return target;
}

/**
 * Полноэкранный проход сведения: глубина фрагмента — минимум двух глубин.
 *
 * Пишется именно ГЛУБИНА (`gl_FragDepth`), а не цвет: карту теней three читает
 * как текстуру глубины с аппаратным сравнением, и цветной «дубликат» ею не
 * является. Тест глубины при этом стоит `ALWAYS`, а запись цвета снята: проход
 * обязан переписать каждый тексель цели и не имеет к цвету никакого отношения.
 */
/**
 * Флаг «карта ждёт перерисовки» — чтением через функцию, а не полем на месте.
 *
 * Сразу после присваивания `needsUpdate = true` анализ потока сужает тип поля
 * до `true`, а снимает флаг чужой код — теневой проход three, которого анализ
 * не видит. Функция возвращает ОБЪЯВЛЕННЫЙ `boolean`, и ответ снова честен.
 */
function shadowPending(shadow: THREE.LightShadow): boolean {
  return shadow.needsUpdate;
}

const COMPOSITE_VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const COMPOSITE_FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform highp sampler2D tStatic;
uniform highp sampler2D tDynamic;

void main() {
  // Ближайший к свету заслон и есть тот, что даёт тень: минимум глубин — это
  // «первое, во что упёрся луч», и он же — карта обоих ярусов сразу (REND-30).
  float staticDepth = texture2D(tStatic, vUv).r;
  float dynamicDepth = texture2D(tDynamic, vUv).r;
  gl_FragDepth = min(staticDepth, dynamicDepth);
  gl_FragColor = vec4(0.0);
}
`;

/** Шейдеры крючка: программа обязана собраться, а рисовать ей нечего. */
const HOOK_VERTEX = `
void main() {
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
`;

const HOOK_FRAGMENT = `
void main() {
  gl_FragColor = vec4(0.0);
}
`;

/**
 * Поле сведения теней: три цели, материал прохода и его квад. Всё, что из этого
 * живёт в GPU, оно отдаёт своей точкой освобождения (REND-31).
 */
export class ShadowComposite {
  private size = 0;
  private staticTarget: THREE.WebGLRenderTarget | null = null;
  private dynamicTarget: THREE.WebGLRenderTarget | null = null;
  private mapTarget: THREE.WebGLRenderTarget | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private quad: THREE.Mesh | null = null;
  private readonly passScene = new THREE.Scene();
  private readonly passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /**
   * Сцена-крючок прохода глубины (см. шапку): один меш, ничего не рисующий, из
   * чьего `onBeforeRender` — изнутри `render()` — заказывается теневой проход.
   */
  private readonly hookScene = new THREE.Scene();
  private hook: THREE.Mesh | null = null;
  /**
   * Проход, заказанный на текущий `render()` крючка; `null` вне его — крючок не
   * держит чужих источника и сцены дольше одного кадра.
   */
  private pending: (() => void) | null = null;
  /**
   * Ярусы, чья глубина уже нарисована хоть раз. До этого в цели лежит мусор
   * драйвера, и сводить её нельзя: первый кадр рисует ОБА яруса (REND-30 —
   * «карта отстаёт не более чем на один свой пропущенный кадр», а не «первый
   * кадр показывает случайную глубину»).
   */
  private drawn: { static: boolean; dynamic: boolean } = { static: false, dynamic: false };
  /** Сведений за жизнь поля — пробник тестов; картинка от него не зависит. */
  private composites = 0;
  /**
   * Проходов глубины по ярусам за жизнь поля — пробник тестов и диагностики:
   * по нему видно чередование ярусов (REND-30), которое раньше читалось флагами
   * `needsUpdate` двух источников.
   */
  private readonly tierDraws = { static: 0, dynamic: 0 };

  /** Сторона целей в текселях; ноль — цели ещё не заводились. */
  get texels(): number {
    return this.size;
  }

  /** Карта, которую читают материалы сцены; `null` — целей ещё нет. */
  get map(): THREE.WebGLRenderTarget | null {
    return this.mapTarget;
  }

  /** Цели ярусов — вход тестов и диагностики (REND-30). */
  get tiers(): {
    readonly static: THREE.WebGLRenderTarget | null;
    readonly dynamic: THREE.WebGLRenderTarget | null;
  } {
    return { static: this.staticTarget, dynamic: this.dynamicTarget };
  }

  /** Материал прохода сведения — вход тестов (REND-30). */
  get pass(): THREE.ShaderMaterial | null {
    return this.material;
  }

  /** Сведений кадра за жизнь поля — пробник тестов. */
  get compositeCount(): number {
    return this.composites;
  }

  /** Проходов глубины по ярусам — пробник чередования (REND-30). */
  get draws(): { readonly static: number; readonly dynamic: number } {
    return this.tierDraws;
  }

  /** Оба ЯРУСА уже нарисованы: до этого сведение идёт по обоим сразу. */
  get primed(): boolean {
    return this.drawn.static && this.drawn.dynamic;
  }

  /**
   * Сторона целей: другая сторона — другие цели (REND-30, потолок пресета
   * QUAL-1). Прежние отдаются здесь же: смена стороны — событие, и держать
   * снятые цели до сноса значило бы возить в памяти карту, которую больше никто
   * не читает.
   */
  resize(size: number): void {
    const side = Math.max(1, Math.round(size));
    if (side === this.size && this.mapTarget !== null) return;
    this.release();
    this.size = side;
    this.staticTarget = createDepthTarget(side, false);
    this.dynamicTarget = createDepthTarget(side, false);
    this.mapTarget = createDepthTarget(side, true);
  }

  /**
   * Глубина одного яруса — в его цель, руками three (REND-30). Подмена
   * `light.shadow.map` на нашу цель и есть весь трюк: теневой проход three
   * рисует в ту цель, которая у источника стоит, а материал глубины каждого
   * объекта выбирает он сам (`customDepthMaterial` батча REND-20, сторона теней,
   * скиннинг) — второй реализации этого выбора у нас нет и быть не должно.
   */
  renderTier(
    renderer: ShadowRendererLike,
    scene: THREE.Object3D,
    camera: THREE.Camera,
    light: THREE.DirectionalLight,
    tier: CompositeTier,
  ): boolean {
    const target = tier === 'static' ? this.staticTarget : this.dynamicTarget;
    if (target === null) return false;
    light.shadow.map = target;
    light.shadow.needsUpdate = true;
    // Проход — изнутри `render()` крючка (см. шапку): снаружи у настоящего
    // рендерера нет состояния кадра, и `shadowMap.render` падает на первом же
    // кастере. Цель `render()` — цель яруса: её проход всё равно очищает и
    // переписывает, а сам крючок не пишет ничего.
    this.ensureHook();
    this.pending = () => {
      renderer.shadowMap.render([light], scene, camera);
    };
    try {
      renderer.setRenderTarget(target);
      renderer.render(this.hookScene, this.passCamera);
      renderer.setRenderTarget(null);
    } finally {
      this.pending = null;
    }
    // СОСТОЯЛСЯ ли проход, видно по флагу: его снимает сам теневой проход
    // three, отрисовав карту, — и не снимает, если тени у потребителя выключены
    // вовсе (`shadowMap.enabled === false`) либо контекст потерян. Заказ, о
    // котором нельзя сказать, что он исполнен, исполненным считать нельзя:
    // кэш статики иначе остался бы устаревшим молча (REND-30).
    const drawn = !shadowPending(light.shadow);
    // Флаг снимается в любом случае: иначе кадр отрисовки сцены
    // (`renderer.render` потребителя) перерисовал бы карту сведения ярусом.
    light.shadow.needsUpdate = false;
    if (!drawn) return false;
    this.tierDraws[tier]++;
    this.drawn[tier] = true;
    return true;
  }

  /**
   * Сведение ярусов в карту источника (REND-30): полноэкранный проход
   * `min(static, dynamic)`. После него `light.shadow.map` — карта сведения, и
   * материалы сцены читают именно её.
   */
  composite(renderer: ShadowRendererLike, light: THREE.DirectionalLight): void {
    const map = this.mapTarget;
    const staticTarget = this.staticTarget;
    const dynamicTarget = this.dynamicTarget;
    if (map === null || staticTarget === null || dynamicTarget === null) return;
    const material = this.ensureMaterial();
    uniformOf(material, 'tStatic').value = staticTarget.depthTexture;
    uniformOf(material, 'tDynamic').value = dynamicTarget.depthTexture;
    renderer.setRenderTarget(map);
    renderer.render(this.passScene, this.passCamera);
    renderer.setRenderTarget(null);
    light.shadow.map = map;
    this.composites++;
  }

  /**
   * Снос (REND-31): цели, их текстуры глубины, материал прохода и геометрия
   * квада. Источник карту при этом теряет — её отдал не он, а мы.
   */
  dispose(): void {
    this.release();
    this.material?.dispose();
    this.material = null;
    this.quad?.geometry.dispose();
    this.quad?.removeFromParent();
    this.quad = null;
    const hook = this.hook;
    if (hook !== null) {
      hook.geometry.dispose();
      (hook.material as THREE.Material).dispose();
      hook.removeFromParent();
      this.hook = null;
    }
  }

  /**
   * Меш-крючок (см. шапку). Геометрия пуста, а материал не пишет ни цвета, ни
   * глубины: `render()` сцены крючка обязан дойти до `onBeforeRender` меша — и
   * не обязан нарисовать ничего. Материал всё же нужен: без него three не
   * ставит объект в список отрисовки вовсе, а с ним компилирует программу один
   * раз за жизнь поля.
   */
  private ensureHook(): THREE.Mesh {
    const existing = this.hook;
    if (existing !== null) return existing;
    const material = own(
      'material',
      'lighting',
      new THREE.ShaderMaterial({
        vertexShader: HOOK_VERTEX,
        fragmentShader: HOOK_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        colorWrite: false,
      }),
    );
    const hook = new THREE.Mesh(own('geometry', 'lighting', new THREE.BufferGeometry()), material);
    hook.frustumCulled = false;
    hook.onBeforeRender = () => {
      this.pending?.();
    };
    this.hookScene.add(hook);
    this.hook = hook;
    return hook;
  }

  /** Цели сведения; квад и материал переживают смену стороны карты. */
  private release(): void {
    for (const target of [this.staticTarget, this.dynamicTarget, this.mapTarget]) {
      target?.depthTexture?.dispose();
      target?.dispose();
    }
    this.staticTarget = null;
    this.dynamicTarget = null;
    this.mapTarget = null;
    this.size = 0;
    this.drawn.static = false;
    this.drawn.dynamic = false;
  }

  private ensureMaterial(): THREE.ShaderMaterial {
    const existing = this.material;
    if (existing !== null) return existing;
    const material = own(
      'material',
      'lighting',
      new THREE.ShaderMaterial({
        vertexShader: COMPOSITE_VERTEX,
        fragmentShader: COMPOSITE_FRAGMENT,
        uniforms: { tStatic: { value: null }, tDynamic: { value: null } },
        // Глубину проход ПИШЕТ, а тест её пропускает всегда: каждый тексель
        // цели обязан получить сведённое значение, а не пройти сравнение с тем,
        // что осталось в буфере от прошлого кадра.
        depthTest: true,
        depthWrite: true,
        depthFunc: THREE.AlwaysDepth,
        colorWrite: false,
      }),
    );
    this.material = material;
    const quad = new THREE.Mesh(
      own('geometry', 'lighting', new THREE.PlaneGeometry(2, 2)),
      material,
    );
    quad.frustumCulled = false;
    this.passScene.add(quad);
    this.quad = quad;
    return material;
  }
}
