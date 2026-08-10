/**
 * Машинный адрес единого конфига камеры (CAM-1, `assets` ASSET-10): секция
 * манифеста визуалов задаёт значения, код — состав параметров и умолчания.
 *
 * Проверяется ровно то, что нормировано: значение из секции доезжает до кадра
 * без правки кода, отсутствие секции и отсутствие параметра означают умолчание
 * кода, а параметр, коду неизвестный, пропускается с предупреждением и отказом
 * не является.
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_CONFIG_DESCRIPTION,
  CAMERA_CONFIG_PARAMS,
  CameraRig,
  DEFAULT_CAMERA_CONFIG,
  cameraConfigFromManifest,
  createCameraInput,
  type CameraPose,
  type CameraRigOptions,
} from '../src/index.js';

/** Поза после нескольких кадров follow — то, что увидит игрок. */
function posed(options: CameraRigOptions): CameraPose {
  const rig = new CameraRig(options);
  const input = createCameraInput();
  let pose = rig.update(input, 1 / 60, { x: 10, y: 10, snap: true });
  for (let i = 0; i < 30; i++) pose = rig.update(input, 1 / 60, { x: 10, y: 10, snap: false });
  return { ...pose };
}

describe('конфиг камеры из секции манифеста (CAM-1, ASSET-10)', () => {
  it('перечень параметров выведен из умолчаний кода, а не набран вторым списком', () => {
    expect(CAMERA_CONFIG_PARAMS).toEqual(Object.keys(DEFAULT_CAMERA_CONFIG));
    expect(CAMERA_CONFIG_DESCRIPTION.params).toBe(CAMERA_CONFIG_PARAMS);
    // Параметры, названные ASSET-10 поимённо, в конфиге есть — иначе у секции
    // не было бы адреса ровно для того, ради чего она заведена.
    for (const param of [
      'pitch',
      'distance',
      'minDistance',
      'maxDistance',
      'fovDeg',
      'panSpeed',
      'followSmoothing',
      'edgeMarginPx',
      'effectsMultiplier',
    ]) {
      expect(CAMERA_CONFIG_PARAMS, param).toContain(param);
    }
  });

  it('секция задаёт наклон и дистанцию — кадр меняется без правки кода', () => {
    const section = { pitch: 0.6, distance: 24 };
    const rig = new CameraRig({ config: cameraConfigFromManifest(section) });
    expect(rig.config).toEqual({ ...DEFAULT_CAMERA_CONFIG, ...section });

    const edited = posed({ config: cameraConfigFromManifest(section) });
    const asIs = posed({});
    expect(edited.pitch).toBe(0.6);
    expect(edited.pitch).not.toBe(asIs.pitch);
    // Дистанция видна позой: точка наблюдения та же, глаз дальше и выше.
    expect(edited.posZ).toBeGreaterThan(asIs.posZ);
  });

  it('нет секции или параметра — умолчание кода, прежнее поведение кадра', () => {
    expect(cameraConfigFromManifest(undefined)).toEqual({});
    expect(new CameraRig({ config: cameraConfigFromManifest(undefined) }).config).toEqual(
      DEFAULT_CAMERA_CONFIG,
    );
    expect(posed({ config: cameraConfigFromManifest(undefined) })).toEqual(posed({}));

    // Параметр по отдельности: остальное остаётся умолчанием.
    const partial = new CameraRig({ config: cameraConfigFromManifest({ fovDeg: 60 }) }).config;
    expect(partial.fovDeg).toBe(60);
    expect(partial.distance).toBe(DEFAULT_CAMERA_CONFIG.distance);
  });

  it('неизвестный параметр — предупреждение и пропуск; остальная секция действует', () => {
    const warnings: string[] = [];
    const config = cameraConfigFromManifest(
      { distance: 20, wobbliness: 3 },
      { warn: (m) => warnings.push(m) },
    );
    expect(config).toEqual({ distance: 20 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/wobbliness/);
  });

  it('не-конечное значение мимо валидации — умолчание кода, а не NaN в кадре', () => {
    const warnings: string[] = [];
    const config = cameraConfigFromManifest(
      { distance: Number.NaN, pitch: 0.5 },
      { warn: (m) => warnings.push(m) },
    );
    expect(config).toEqual({ pitch: 0.5 });
    expect(new CameraRig({ config }).config.distance).toBe(DEFAULT_CAMERA_CONFIG.distance);
    expect(warnings).toHaveLength(1);
  });
});
