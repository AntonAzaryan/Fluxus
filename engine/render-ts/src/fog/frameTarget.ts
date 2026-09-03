/**
 * Промежуточная цель кадра тумана (FOW-7, design D2) — путь БЕЗ активной
 * пост-обработки: сцена рисуется в неё, а маскирующий проход читает её цвет и
 * глубину. При активной цепочке (REND-34) сцену рисует она, и цель эта не нужна
 * ни одному проходу — подсистема отдаёт её сразу, а не доживает до сноса
 * (REND-31).
 *
 * Врозь с подсистемой потому, что это отдельное владение: цель, её текстура
 * глубины и правило «пересоздать при смене размера окна» не знают ни о маске,
 * ни о наблюдателях, ни о конфигурации.
 */
import * as THREE from 'three';
import type { ScenePostFrame } from '../types.js';
import { own } from '../footprint.js';

/**
 * Мультисэмплинг цели. Столько же, сколько у цепочки пост-обработки (REND-34):
 * кадр рисуется либо в неё, либо в эту цель, и кромка геометрии обязана быть
 * одинаковой в обоих путях. Цель без `samples` молча снимала бы антиалиасинг
 * рёбер со всего кадра — первая же построенная маска делала картинку хуже, чем
 * без тумана вовсе.
 */
const TARGET_SAMPLES = 4;

/** Рендерер глазами этой цели — тот же структурный минимум, что у подсистемы. */
interface TargetRenderer {
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setRenderTarget(target: THREE.WebGLRenderTarget | null): void;
  getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}

export class FogFrameTarget {
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly sizeScratch = new THREE.Vector2();

  /** Живая цель или null — кадра ещё не было либо её отдали (вход тестов). */
  get current(): THREE.WebGLRenderTarget | null {
    return this.target;
  }

  /**
   * Своя отрисовка сцены в цель под размер буфера рисования. Возвращает вход
   * маскирующего прохода в той же форме, в какой его отдаёт порт цепочки
   * (design D2): два пути входа маски различаются тем, КТО нарисовал сцену, а
   * не тем, что получает маскирующий проход.
   */
  render(renderer: TargetRenderer, scene: THREE.Object3D, camera: THREE.Camera): ScenePostFrame {
    const size = renderer.getDrawingBufferSize(this.sizeScratch);
    const target = this.ensure(Math.max(1, Math.floor(size.x)), Math.max(1, Math.floor(size.y)));
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    // ponytail (REND-26): одна запись на кадр с построенной маской, а не на
    // инстанс, — та же, что отдаёт порт цепочки, и по тому же основанию.
    return { color: target.texture, depth: target.depthTexture };
  }

  /**
   * Отдаёт цель вместе с её текстурой глубины (REND-31). Текстуру заводит ЭТОТ
   * модуль, а не цель: `dispose()` цели рассылает только собственное событие,
   * поэтому без этой строки текстура пережила бы и смену размера окна, и снос
   * подсистемы — молча, по одной на каждый ресайз.
   */
  release(): void {
    if (this.target === null) return;
    this.target.depthTexture?.dispose();
    this.target.dispose();
    this.target = null;
  }

  private ensure(width: number, height: number): THREE.WebGLRenderTarget {
    if (this.target !== null && this.target.width === width && this.target.height === height) {
      return this.target;
    }
    this.release();
    const depthTexture = own('texture', 'fog', new THREE.DepthTexture(width, height));
    this.target = own(
      'renderTarget',
      'fog',
      new THREE.WebGLRenderTarget(width, height, {
        depthTexture,
        depthBuffer: true,
        samples: TARGET_SAMPLES,
      }),
    );
    return this.target;
  }
}
