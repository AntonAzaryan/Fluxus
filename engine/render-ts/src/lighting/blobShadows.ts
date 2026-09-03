/**
 * Контактные пятна режима теней `blob` (`rendering` REND-30) — механизм отдельно
 * от подсистемы освещения (`subsystems/lighting.ts`) тем же швом, каким рядом
 * живут пул локальных источников (`localLights.ts`) и часы цикла (`cycle.ts`):
 * подсистема держит РЕЖИМ и счётчики стоимости, а здесь — реестр носителей,
 * геометрия пятен и их кадровая запись.
 *
 * ## Один инстанс-меш, не декаль на инстанс (design D3)
 *
 * Пятна — ОДИН `InstancedMesh` круглого квада с мягкой текстурой: сцене они
 * стоят один draw call при любом числе носителей, а появление и исчезновение
 * пятна — это `count` кадра, а не добавление узла в сцену. Отдельная декаль на
 * инстанс дала бы то же изображение ценой узла, материала и вызова отрисовки на
 * каждого юнита — то самое, ради ухода от чего режим и заводится (слабое
 * железо).
 *
 * Текстура ГЕНЕРИРУЕТСЯ, а не приезжает ассетом: у пятна нет авторской формы —
 * это радиальный спад, — и ассет означал бы файл в дереве контента, без которого
 * режим не работает (CONT-4 и лишняя зависимость режима от комплектации сцены).
 *
 * ## Почему пятно рисуется в основной проход
 *
 * Маска тумана — ФИНАЛЬНЫЙ проход кадра (FOW-7), и пятно, нарисованное сценой,
 * затемняется ею наравне с самим инстансом: по пятну нельзя прочитать позицию
 * невидимого юнита (REND-30, QUAL-2). Никакой собственной логики видимости
 * пятнам поэтому не нужно.
 *
 * ## Аллокации
 *
 * Матрица кадра, вектор позиции и кватернион — переиспользуемые поля (REND-26).
 * Аллокация здесь одна и событийная: рост ёмкости инстанс-меша, когда носителей
 * стало больше, чем он вмещает. Ёмкость удваивается, поэтому за жизнь сцены
 * ростов — логарифм от числа носителей, а не число кадров.
 */
import * as THREE from 'three';
import type { BlobCaster, BlobCasterPose } from '../types.js';
import { own } from '../footprint.js';

/**
 * Сторона генерируемой текстуры пятна в текселях. Шестьдесят четыре — предел, за
 * которым мягкий круг перестаёт быть виден чётче: пятно на экране занимает
 * десятки пикселей, а сама форма — гладкий радиальный спад без деталей.
 */
const TEXTURE_SIZE = 64;

/**
 * Показатель спада прозрачности от центра к краю. Двойка — квадратичный спад:
 * центр плотный, край растворяется, и кромка пятна не читается окружностью.
 */
const FALLOFF_POWER = 2;

/**
 * Подъём пятна над точкой опоры инстанса, мировые единицы. Пятно лежит на
 * террейне, а террейн — та же геометрия, что рисует пол: без подъёма два
 * ко-планарных треугольника дерутся за глубину (z-fighting) и пятно мерцает.
 * Величина мала намеренно — пятно обязано читаться прижатым к земле.
 *
 * Подъём идёт ВДОЛЬ НОРМАЛИ опоры, а не по вертикали, и вместе с поворотом
 * квада по той же нормали делает величину независимой от уклона: подъём по
 * вертикали на склоне θ отрывал бы пятно от земли на `подъём / cos θ`, а
 * горизонтальный круг вообще уходил бы в грунт уже в `подъём / tg θ` от центра.
 */
const LIFT_WORLD_UNITS = 0.02;

/**
 * Локальная нормаль квада пятна: `PlaneGeometry` лежит в плоскости XY, и его
 * нормаль — +Z. От неё поворотом (`setFromUnitVectors`) считается ориентация
 * инстанса по нормали опоры.
 */
const QUAD_NORMAL = new THREE.Vector3(0, 0, 1);

/** Начальная ёмкость инстанс-меша: типовой арене хватает без единого роста. */
const INITIAL_CAPACITY = 32;

/**
 * Мягкий круг в RGBA: цвет чёрный, спад — в альфе. Именно альфой, а не
 * яркостью: пятно ЗАТЕМНЯЕТ поверхность, и белый край на светлом полу был бы
 * виден нимбом.
 */
function createBlobTexture(): THREE.DataTexture {
  const side = TEXTURE_SIZE;
  const data = new Uint8Array(side * side * 4);
  const center = (side - 1) / 2;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const distance = Math.hypot(dx, dy);
      const alpha = distance >= 1 ? 0 : (1 - distance) ** FALLOFF_POWER;
      const at = (y * side + x) * 4;
      data[at + 3] = Math.round(alpha * 255);
    }
  }
  const texture = own(
    'texture',
    'lighting',
    new THREE.DataTexture(data, side, side, THREE.RGBAFormat),
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Поле контактных пятен: ему принадлежат реестр носителей, текстура, материал,
 * геометрия и инстанс-меш — и всё, что из этого живёт в GPU, оно отдаёт своей
 * точкой освобождения (REND-31).
 */
export class BlobShadowField {
  /**
   * Реестр носителей (REND-30) — те же инстансы, что объявили себя ДИНАМИЧЕСКИМ
   * ярусом кастеров, но пер-инстансно: корень батчевого яруса (REND-20) один на
   * десятки инстансов, и пятно по нему вышло бы одно на весь батч.
   *
   * Наполняется владельцем инстансов независимо от действующего режима теней —
   * это условие ED-15: смена режима правкой секции обязана показать пятна
   * ближайшим кадром, а не по мере пересоздания инстансов. Стоимости у реестра
   * нет: по нему ходит только кадр режима `blob`.
   */
  private readonly casters = new Set<BlobCaster>();
  private readonly texture = createBlobTexture();
  private readonly geometry = own('geometry', 'lighting', new THREE.PlaneGeometry(1, 1));
  private readonly material: THREE.MeshBasicMaterial;
  private mesh: THREE.InstancedMesh | null = null;
  private capacity = 0;
  private scene: THREE.Object3D | null = null;

  /** Переиспользуемые поля кадрового пути (REND-26). */
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly pose: BlobCasterPose = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };

  constructor() {
    this.material = own(
      'material',
      'lighting',
      new THREE.MeshBasicMaterial({
        map: this.texture,
        color: 0x000000,
        transparent: true,
        depthWrite: false,
        // Пятно почти ко-планарно полу: смещение глубины гасит остаток
        // z-fighting'а на дальних текселях карты глубины, где подъёма в 0.02
        // мировых единицы уже не хватает разрешению буфера. Геометрического
        // пересечения со склоном оно НЕ лечит и лечить не может — там работают
        // поворот квада по нормали опоры и подъём вдоль неё.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
  }

  /** Пятен, написанных последним кадром, — вход счётчиков стоимости и тестов. */
  get drawn(): number {
    return this.mesh?.count ?? 0;
  }

  /** Носителей в реестре — пробник тестов и диагностики (REND-30). */
  get casterCount(): number {
    return this.casters.size;
  }

  /** Носитель появился; повторный вызов с тем же носителем последствий не имеет. */
  add(caster: BlobCaster): void {
    this.casters.add(caster);
  }

  /** Носитель ушёл: снятый инстанс либо инстанс, ставший статическим кастером. */
  remove(caster: BlobCaster): void {
    this.casters.delete(caster);
  }

  /** Инстанс-меш пятен; `null` — режим `blob` ещё не приходил (PERF-2). */
  get instances(): THREE.InstancedMesh | null {
    return this.mesh;
  }

  /** Сцена подсистем (REND-8): в неё меш встанет первым кадром режима `blob`. */
  init(scene: THREE.Object3D): void {
    this.scene = scene;
  }

  /**
   * Кадр поля: позы носителей — в инстанс-матрицы, число написанных — в `count`.
   * Возвращает число нарисованных пятен: его подсистема кладёт в сток стоимости
   * (PERF-2), а не считает вторым проходом.
   *
   * Носитель без позы кадра (инстанс ещё не поставлен, отсечён) пятна не даёт:
   * `pose` отвечает `false`, и место в буфере ему не выделяется вовсе.
   */
  updateFrame(): number {
    const casters = this.casters;
    const count = casters.size;
    if (count === 0) {
      // Пустой реестр — работы нет и меша в сцене может не быть вовсе: сцена
      // без динамики за режим не платит ничем (PERF-2).
      if (this.mesh !== null) this.mesh.count = 0;
      return 0;
    }
    const mesh = this.ensureMesh(count);
    let written = 0;
    for (const caster of casters) {
      if (!caster.pose(this.pose)) continue;
      const diameter = Math.max(0, caster.radius) * 2;
      // Ориентация — по нормали опоры (REND-30): на склоне пятно ложится
      // плашмя, а не режется грунтом. Вырожденную нормаль (её у поверхности не
      // бывает, но контракт записи её не запрещает) заменяет вертикаль:
      // нормировать ноль нечем, и квад тогда остаётся горизонтальным.
      this.normal.set(this.pose.nx, this.pose.ny, this.pose.nz);
      if (this.normal.lengthSq() > 0) this.normal.normalize();
      else this.normal.copy(QUAD_NORMAL);
      this.quaternion.setFromUnitVectors(QUAD_NORMAL, this.normal);
      // Подъём — вдоль той же нормали: по вертикали он на склоне отрывал бы
      // пятно от земли тем сильнее, чем круче уклон.
      this.position
        .set(this.pose.x, this.pose.y, this.pose.z)
        .addScaledVector(this.normal, LIFT_WORLD_UNITS);
      this.scale.set(diameter, diameter, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(written, this.matrix);
      written++;
    }
    mesh.count = written;
    mesh.instanceMatrix.needsUpdate = true;
    return written;
  }

  /**
   * Режим больше не `blob`: пятна уходят из кадра. Меш при этом остаётся живым —
   * смена режима туда-обратно не должна пересоздавать буфер, — но не рисуется.
   */
  hide(): void {
    if (this.mesh === null) return;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Снос (REND-31): меш, его буферы, материал, геометрия и текстура пятна. */
  dispose(): void {
    this.casters.clear();
    this.mesh?.removeFromParent();
    this.mesh?.dispose();
    this.mesh = null;
    this.capacity = 0;
    this.material.dispose();
    this.geometry.dispose();
    this.texture.dispose();
    this.scene = null;
  }

  /**
   * Инстанс-меш ёмкостью не меньше нужной. Ёмкость УДВАИВАЕТСЯ: пересоздание
   * буфера — аллокация, и делать её линейно числу спавнов значило бы платить
   * ею за каждого нового юнита.
   */
  private ensureMesh(needed: number): THREE.InstancedMesh {
    const existing = this.mesh;
    if (existing !== null && this.capacity >= needed) {
      existing.visible = true;
      return existing;
    }
    let capacity = Math.max(INITIAL_CAPACITY, this.capacity);
    while (capacity < needed) capacity *= 2;
    existing?.removeFromParent();
    existing?.dispose();
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = 'lighting:blob-shadows';
    // Матрицы инстансов переписываются каждым кадром — собственные границы меша
    // им не поспевают, и отсекать его по ним значило бы гасить пятна вслепую.
    mesh.frustumCulled = false;
    // Пятно — приёмник изображения, а не участник теневого прохода: собственных
    // теней оно не отбрасывает и чужие на себя не принимает (REND-30).
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.count = 0;
    this.mesh = mesh;
    this.capacity = capacity;
    this.scene?.add(mesh);
    return mesh;
  }
}
