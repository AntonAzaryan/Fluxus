/**
 * Двойник рендерера глазами теневых проходов (`rendering` REND-30) — общий для
 * стендов интеграции: подсистема света в `hybrid` ведёт проходы сама — рисует
 * глубину яруса кадра и сводит ярусы в карту источника, — а без порта исполняла
 * бы режим как `full`, и стенд мерил бы не тот режим, что назван секцией.
 *
 * Живого WebGL двойнику не нужно: он повторяет два наблюдаемых свойства
 * настоящего `THREE.WebGLRenderer`, и ровно те, от которых зависит подсистема:
 *
 * - проход снимает флаг `needsUpdate` у нарисованного источника — по нему
 *   подсистема подтверждает состоявшуюся перерисовку;
 * - проход законен только ИЗНУТРИ `render()`: состояние кадра у настоящего
 *   рендерера существует только там, и заказанный снаружи `shadowMap.render`
 *   падает на первом же кастере. Двойник падает так же — иначе стенд зеленел бы
 *   там, где браузер падает. Внутрь `render()` подсистема заходит крючком —
 *   мешем, ничего не рисующим, из чьего `onBeforeRender` и идёт проход
 *   (`ShadowComposite`), — и `render()` двойника делает с ним то единственное,
 *   что делает настоящий: зовёт `onBeforeRender`.
 */
import * as THREE from 'three';
import type { ShadowRendererLike } from '@fluxus/render';

export function shadowRendererFake(): ShadowRendererLike {
  let rendering = false;
  const fake: ShadowRendererLike = {
    render: (scene, camera) => {
      rendering = true;
      try {
        scene.traverse((object) => {
          if (!('isMesh' in object)) return;
          const mesh = object as THREE.Mesh;
          mesh.onBeforeRender(
            fake as THREE.WebGLRenderer,
            scene as THREE.Scene,
            camera,
            mesh.geometry,
            mesh.material as THREE.Material,
            null as unknown as THREE.Group,
          );
        });
      } finally {
        rendering = false;
      }
    },
    setRenderTarget: () => {},
    shadowMap: {
      enabled: true,
      render: (lights) => {
        if (!rendering) {
          throw new Error('теневой проход three вне render(): состояния кадра здесь нет');
        }
        for (const light of lights) (light as THREE.DirectionalLight).shadow.needsUpdate = false;
      },
    },
  };
  return fake;
}
