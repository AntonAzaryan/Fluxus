/**
 * Режим облёта (CAM-2) — свободный полёт наблюдателя и отладки: направление
 * взгляда мышью, перемещение клавишами, колесо — скорость полёта, а не
 * дистанция (CAM-4).
 *
 * Отдельно от конвейера, потому что его состояние ЗАМКНУТО и с наземными
 * режимами не пересекается вовсе: позиция полёта, курс, наклон и скорость живут
 * только здесь, а конвейеру остаётся переключатель. Тот же раздел, по которому
 * отдельно живут геометрия кадрирования (`framing.ts`) и оценка пути
 * (`path.ts`): headless-величины считаются там, где их видно целиком.
 */
import type { CameraConfig, CameraPose } from './rig.js';
import type { CameraInput } from './input.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Состояние облёта: своя позиция и свой взгляд, независимые от наземной позы. */
export class CameraFly {
  private readonly config: CameraConfig;
  private x = 0;
  private y = 0;
  private z = 0;
  private yaw: number;
  private pitch: number;
  private speed: number;

  constructor(config: CameraConfig) {
    this.config = config;
    this.yaw = config.yaw;
    this.pitch = config.pitch;
    this.speed = config.flySpeed;
  }

  /** Вход в облёт из ТЕКУЩЕЙ позы — чтобы включение не давало скачка (CAM-2). */
  enter(pose: CameraPose): void {
    this.x = pose.posX;
    this.y = pose.posY;
    this.z = pose.posZ;
    this.yaw = pose.yaw;
    this.pitch = pose.pitch;
  }

  /** Кадр облёта: пишет позу конвейера по своему состоянию (CAM-1, CAM-2). */
  update(input: CameraInput, dt: number, pose: CameraPose): void {
    const cfg = this.config;
    // Колесо в fly — скорость полёта, не дистанция (CAM-4).
    if (input.wheelSteps !== 0) {
      this.speed = clamp(
        this.speed * Math.pow(cfg.flySpeedStep, -input.wheelSteps),
        cfg.flySpeedMin,
        cfg.flySpeedMax,
      );
    }
    this.yaw -= input.lookDX * cfg.lookSensitivity;
    this.pitch = clamp(
      this.pitch + input.lookDY * cfg.lookSensitivity,
      -Math.PI / 2 + 0.05,
      Math.PI / 2 - 0.05,
    );

    const cosP = Math.cos(this.pitch);
    // Векторы взгляда: forward — куда смотрим, right — вбок в плоскости XY.
    const fx = Math.cos(this.yaw) * cosP;
    const fy = Math.sin(this.yaw) * cosP;
    const fz = -Math.sin(this.pitch);
    const rx = Math.sin(this.yaw);
    const ry = -Math.cos(this.yaw);
    const step = this.speed * dt;
    this.x += (fx * input.moveY + rx * input.moveX) * step;
    this.y += (fy * input.moveY + ry * input.moveX) * step;
    this.z += (fz * input.moveY + input.moveZ) * step;

    pose.posX = this.x;
    pose.posY = this.y;
    pose.posZ = this.z;
    pose.yaw = this.yaw;
    pose.pitch = this.pitch;
    pose.roll = 0;
    pose.fovDeg = cfg.fovDeg;
  }
}
