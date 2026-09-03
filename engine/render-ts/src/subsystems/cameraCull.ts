/**
 * Отсечение работы подсистем-оболочек по камере (REND-24, REND-43, QUAL-3): что за
 * пирамидой кадра и что слишком далеко.
 *
 * Отдельным модулем, потому что владельцев у правила два — частицы и
 * транзиентные эффекты, — а вопрос один: «стоит ли тратить кадр на объект,
 * которого игрок не увидит». Подсистема моделей отсекает СВОИ инстансы своими
 * границами (REND-21, REND-22) и в этот модуль не заходит: её объём известен по
 * ассету, а у эмиттера и у наземной фигуры объёма нет вовсе — есть якорь и
 * запас вокруг него.
 *
 * Камера приходит ОПЦИЕЙ подсистемы, а не контекстом (REND-8), тем же путём,
 * каким её получает подсистема моделей: контракт подсистем от отсечения не
 * меняется, а поза камеры — перечисленный несимуляционный вход (REND-1).
 * Сборка без камеры (тесты, headless) отсечения не имеет вовсе и делает ту же
 * работу, что делала до него: стоимость, а не поведение.
 *
 * Аллокаций на кадр здесь нет: и пирамида, и сфера, и позиция камеры —
 * переиспользуемые объекты владельца.
 */
import * as THREE from 'three';

/**
 * Состояние отсечения одного кадра: пирамида камеры и её позиция. Обновляется
 * один раз на кадр владельцем, спрашивается — на каждый объект.
 */
export class CameraCull {
  private readonly frustum = new THREE.Frustum();
  private readonly matrix = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly eye = new THREE.Vector3();
  private ready = false;

  /**
   * Матрицы кадра, с которыми он и будет нарисован: позу на камеру сажает
   * сборка до кадра подсистем (CAM-1), второго расчёта здесь нет. `false` —
   * камеры нет, и отсечения не существует.
   */
  update(camera: THREE.Camera | undefined): boolean {
    if (camera === undefined) {
      this.ready = false;
      return false;
    }
    camera.updateMatrixWorld();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.ready = true;
    return true;
  }

  /** Готово ли отсечение этого кадра: `false` — сборка без камеры. */
  get active(): boolean {
    return this.ready;
  }

  /**
   * Виден ли якорь радиуса `radius` и не дальше ли он `maxDistance` от камеры.
   * `maxDistance <= 0` — предела расстояния нет вовсе.
   *
   * Радиус здесь — ЗАПАС, а не габариты: у эмиттера частиц объёма не существует
   * (его частицы разлетаются, куда велит документ), и отсечь его по точке
   * значило бы гасить дым, чей источник только что ушёл за кромку кадра.
   */
  visible(x: number, y: number, z: number, radius: number, maxDistance: number): boolean {
    if (!this.ready) return true;
    this.sphere.center.set(x, y, z);
    this.sphere.radius = radius;
    if (maxDistance > 0 && this.sphere.center.distanceTo(this.eye) - radius > maxDistance) {
      return false;
    }
    return this.frustum.intersectsSphere(this.sphere);
  }
}
