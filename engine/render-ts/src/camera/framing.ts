/**
 * Геометрия кадрирования (CAM-8): дистанция, на которой заданный мировой
 * прямоугольник целиком попадает в кадр при действующих наклоне, повороте и FOV.
 *
 * Отдельным модулем от конвейера, потому что это ЧИСТАЯ функция чисел: на входе
 * конфиг, прямоугольник и пропорции кадра, на выходе одна величина. Состояния
 * рига она не читает и не пишет — кламп по инжектированным границам (CAM-3,
 * CAM-7) и решение «мгновенно или перелётом» остаются его делом.
 */
import type { CameraBounds, CameraConfig } from './rig.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Дистанция кадрирования, склампленная теми же пределами, что зум (CAM-4):
 * прямоугольник, не влезающий на предельной дистанции, показывается настолько
 * целиком, насколько пределы позволяют, и отказом это не является.
 *
 * Точка наземного прямоугольника, отстоящая от центра на `s` вдоль направления
 * взгляда, лежит в кадровых координатах на глубине `s·cos p + d` и на высоте
 * `s·sin p` (p — наклон, d — дистанция). Условие «попадает в вертикальный угол»
 * упирается первым у ближнего края (s < 0), откуда `d ≥ h·(sin p / tan v + cos p)`.
 * Поперёк взгляда высоты нет, а глубина у ближнего края наименьшая, откуда
 * `d ≥ w / tan h + h·cos p`. Ограничивающим берётся больший из двух: тот габарит,
 * который упирается первым.
 *
 * Пропорции кадра — от потребителя, и негодные (кадр нулевого размера) не повод
 * отдать NaN: горизонталь тогда не ограничивает, а вертикаль считается как
 * считалась. Спрашивать размеры конвейеру всё равно негде (CAM-1).
 */
export function framingDistance(
  config: CameraConfig,
  rect: CameraBounds,
  aspect: number,
): number {
  // Полуразмеры прямоугольника в осях кадра: прямоугольник задан в мировых
  // осях, а упирается он в углы кадра, повёрнутого на `yaw`. Опорная функция
  // прямоугольника вдоль оси и даёт полуразмер вдоль неё.
  const halfX = Math.abs(rect.maxX - rect.minX) / 2;
  const halfY = Math.abs(rect.maxY - rect.minY) / 2;
  const cosYaw = Math.abs(Math.cos(config.yaw));
  const sinYaw = Math.abs(Math.sin(config.yaw));
  const along = cosYaw * halfX + sinYaw * halfY;
  const across = sinYaw * halfX + cosYaw * halfY;

  const tanV = Math.tan(((config.fovDeg / 2) * Math.PI) / 180);
  const cosPitch = Math.cos(config.pitch);
  const sinPitch = Math.sin(config.pitch);
  const vertical = tanV > 0 ? along * (sinPitch / tanV + cosPitch) : along;
  const tanH = Number.isFinite(aspect) && aspect > 0 ? tanV * aspect : 0;
  const horizontal = tanH > 0 ? across / tanH + along * cosPitch : 0;

  return clamp(Math.max(vertical, horizontal), config.minDistance, config.maxDistance);
}
