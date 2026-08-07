/**
 * Манифест визуалов (ASSET-6): data-driven JSON-документ «sim-идентификатор
 * сущности → визуал», отдельный от конфига сцены. Ссылки направлены только из
 * манифеста в sim-идентификаторы (имена prefab'ов); sim-описания сущностей
 * путей к presentation-ассетам не содержат. Правка манифеста не меняет
 * `worldInit`, снапшоты, golden-файлы и совместимость реплеев.
 *
 * Манифест — политика, не механизм: какая модель у юнита, какой клип на какое
 * действие, какие лимиты у поворота головы — решает этот JSON, а не код.
 */

/** Ключ — sim-идентификатор (имя prefab'а/архетипа). */
export interface VisualManifest {
  entities: Record<string, EntityVisual>;
  /** Дефолт наклона по поверхности для записей без своего surfaceAlign (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Presentation-данные террейна арены. */
  terrain?: { curvatureMap?: string };
  /** Секция эффектов камеры (ASSET-8); потребитель — `camera` CAM-6. */
  cameraEffects?: CameraEffectsSection;
}

/**
 * Секция эффектов камеры (ASSET-8): таблицы «тип события тика → импульсный
 * эффект» и «компонента-состояние сущности → длящийся эффект». Набор типов
 * эффектов определяется кодом камеры; привязка и числа — только здесь.
 * Запись с неизвестным типом эффекта — предупреждение и пропуск на
 * потребителе, не ошибка валидации: манифест переживает код.
 */
export interface CameraEffectsSection {
  events?: Record<string, CameraEffectDef>;
  states?: Record<string, CameraEffectDef>;
}

/** Тип эффекта плюс его числовые параметры (амплитуда, частота, радиус…). */
export interface CameraEffectDef {
  effect: string;
  [param: string]: string | number;
}

/**
 * Наклон инстанса по нормали визуальной поверхности (REND-10): up-вектор —
 * slerp(вертикаль, нормаль, factor); maxAngleDeg ограничивает итоговое
 * отклонение от вертикали при любом factor.
 */
export interface SurfaceAlign {
  /** 0 — всегда вертикален, 1 — перпендикулярен поверхности. */
  factor: number;
  maxAngleDeg?: number;
}

/** Дефолт REND-10: перпендикулярен поверхности, без лимита угла. */
export const DEFAULT_SURFACE_ALIGN: Readonly<SurfaceAlign> = Object.freeze({ factor: 1 });

/**
 * Вертикальное смещение инстанса (REND-12): дуга прыжка и снижение при
 * провале. Вертикали в симуляции нет (`locomotion` LOC-5), поэтому числа
 * художественные и живут только здесь. Все поля опциональны, отсутствие
 * означает отсутствие смещения — глобального дефолта у секции намеренно нет:
 * высота прыжка — свойство персонажа, а не мира (в отличие от наклона).
 */
export interface VerticalOffset {
  /** Максимум дуги прыжка в мировых единицах; без него дуги нет. */
  jumpArc?: number;
  /** Скорость снижения при провале, мировых единиц в секунду. */
  fallSpeed?: number;
  /** На сколько инстанс уходит вниз и там останавливается. */
  fallDepth?: number;
}

/** Параметры наклона записи: свои → дефолт манифеста → дефолт спеки (ASSET-6). */
export function resolveSurfaceAlign(
  manifest: Pick<VisualManifest, 'surfaceAlign'>,
  visual: EntityVisual | undefined,
): SurfaceAlign {
  return visual?.surfaceAlign ?? manifest.surfaceAlign ?? DEFAULT_SURFACE_ALIGN;
}

export interface EntityVisual {
  /** Asset id модели. */
  model: string;
  /** Мировая высота юнита; по умолчанию 1. */
  scale?: number;
  /**
   * Куда смотрит МОДЕЛЬ в канонических осях модуля — угол в градусах против
   * часовой стрелки от `+X` (REND-13). Это описание самой модели, а не поправка
   * к курсу: поправку рендер выводит сам.
   *
   * Перёд — свойство авторинга модели, а не системы координат: канонические оси
   * (ASSET-5) фиксируют, где верх и какова единица длины, но не то, куда
   * повёрнуто лицо, и вывести это из файла нельзя. Поэтому значение живёт в
   * записи, а не одним числом на всех: модели разных форматов с разным передом
   * сосуществуют в одной сцене.
   *
   * Примеры: у моделей MDX лицо вдоль `+X` — это `0` (и умолчание при
   * отсутствии поля); у glTF-модели, чьё лицо смотрит вдоль `−Y`, это `-90`.
   */
  facingDeg?: number;
  defaultSkin?: string;
  /** Имя скина → (номер textureSlot как строка → asset id текстуры). */
  skins?: Record<string, Record<string, string>>;
  /** Состояние рендера ('idle', 'move', 'dodge', 'roll', 'jump', 'fall') → подстрока имени клипа; имя события → подстрока имени клипа (REND-4). */
  animations?: { states?: Record<string, string>; events?: Record<string, string> };
  /** Роль ('torso', 'head') → параметры процедурного контроля кости (REND-5). */
  boneControls?: Record<string, { bone: string; maxYawDeg: number; smoothing: number }>;
  /** Индексы частей модели (`NormalizedMesh.partId`), исключаемых из рендера. */
  hiddenParts?: number[];
  /** Наклон по нормали визуальной поверхности; без него — дефолт манифеста (REND-10). */
  surfaceAlign?: SurfaceAlign;
  /** Дуга прыжка и снижение при провале (REND-12); без секции — смещения нет. */
  verticalOffset?: VerticalOffset;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'массив';
  return typeof v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Ругаемся на неизвестные поля: в data-driven документе это почти всегда опечатка. */
function checkUnknownKeys(
  obj: Record<string, unknown>,
  known: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      errors.push(`${path}.${key}: неизвестное поле (допустимы: ${known.join(', ')})`);
    }
  }
}

/** Запись «строка → строка» с непустыми значениями. */
function validateStringMap(v: unknown, path: string, what: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект «${what}», получено ${typeName(v)}`);
    return;
  }
  for (const [key, val] of Object.entries(v)) {
    if (typeof val !== 'string' || val.length === 0) {
      errors.push(`${path}.${key}: ожидалась непустая строка, получено ${typeName(val)}`);
    }
  }
}

/** `surfaceAlign` записи или манифеста: factor в [0..1], лимит угла >= 0 (REND-10). */
function validateSurfaceAlign(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(`${path}: ожидался объект { factor, maxAngleDeg? }, получено ${typeName(v)}`);
    return;
  }
  checkUnknownKeys(v, ['factor', 'maxAngleDeg'], path, errors);
  if (!isFiniteNumber(v.factor) || v.factor < 0 || v.factor > 1) {
    errors.push(`${path}.factor: обязательное поле — число в [0..1], получено ${typeName(v.factor)}`);
  }
  if ('maxAngleDeg' in v && (!isFiniteNumber(v.maxAngleDeg) || v.maxAngleDeg < 0)) {
    errors.push(`${path}.maxAngleDeg: ожидалось неотрицательное число градусов`);
  }
}

/** `verticalOffset` записи: все поля опциональны и неотрицательны (REND-12). */
function validateVerticalOffset(v: unknown, path: string, errors: string[]): void {
  if (!isRecord(v)) {
    errors.push(
      `${path}: ожидался объект { jumpArc?, fallSpeed?, fallDepth? }, получено ${typeName(v)}`,
    );
    return;
  }
  const fields = ['jumpArc', 'fallSpeed', 'fallDepth'] as const;
  checkUnknownKeys(v, fields, path, errors);
  for (const field of fields) {
    const value = v[field];
    if (field in v && (!isFiniteNumber(value) || value < 0)) {
      errors.push(`${path}.${field}: ожидалось неотрицательное число мировых единиц`);
    }
  }
}

function validateEntity(entity: unknown, path: string, errors: string[]): void {
  if (!isRecord(entity)) {
    errors.push(`${path}: ожидался объект визуала, получено ${typeName(entity)}`);
    return;
  }
  checkUnknownKeys(
    entity,
    [
      'model',
      'scale',
      'facingDeg',
      'defaultSkin',
      'skins',
      'animations',
      'boneControls',
      'hiddenParts',
      'surfaceAlign',
      'verticalOffset',
    ],
    path,
    errors,
  );

  if ('surfaceAlign' in entity) {
    validateSurfaceAlign(entity.surfaceAlign, `${path}.surfaceAlign`, errors);
  }

  if ('verticalOffset' in entity) {
    validateVerticalOffset(entity.verticalOffset, `${path}.verticalOffset`, errors);
  }

  if (typeof entity.model !== 'string' || entity.model.length === 0) {
    errors.push(`${path}.model: обязательное поле — непустая строка (asset id модели)`);
  }

  if ('scale' in entity && (!isFiniteNumber(entity.scale) || entity.scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное число, получено ${typeName(entity.scale)}`);
  }

  // Диапазон не ограничиваем: угол заворачивается, и «-90» и «270» одинаково
  // законны — требовать канонической записи значило бы придираться к автору.
  if ('facingDeg' in entity && !isFiniteNumber(entity.facingDeg)) {
    errors.push(
      `${path}.facingDeg: ожидался угол переда модели в градусах (число), получено ${typeName(entity.facingDeg)}`,
    );
  }

  const skins = entity.skins;
  if ('skins' in entity) {
    if (!isRecord(skins)) {
      errors.push(`${path}.skins: ожидался объект «имя скина → подмены слотов», получено ${typeName(skins)}`);
    } else {
      for (const [skinName, slots] of Object.entries(skins)) {
        const skinPath = `${path}.skins.${skinName}`;
        if (!isRecord(slots)) {
          errors.push(`${skinPath}: ожидался объект «номер textureSlot → asset id текстуры», получено ${typeName(slots)}`);
          continue;
        }
        for (const [slot, tex] of Object.entries(slots)) {
          if (!/^\d+$/.test(slot)) {
            errors.push(`${skinPath}: ключ "${slot}" не является номером textureSlot`);
          }
          if (typeof tex !== 'string' || tex.length === 0) {
            errors.push(`${skinPath}.${slot}: ожидался asset id текстуры (непустая строка), получено ${typeName(tex)}`);
          }
        }
      }
    }
  }

  if ('defaultSkin' in entity) {
    if (typeof entity.defaultSkin !== 'string' || entity.defaultSkin.length === 0) {
      errors.push(`${path}.defaultSkin: ожидалась непустая строка, получено ${typeName(entity.defaultSkin)}`);
    } else if (!isRecord(skins) || !(entity.defaultSkin in skins)) {
      errors.push(`${path}.defaultSkin: скин "${entity.defaultSkin}" не описан в ${path}.skins`);
    }
  }

  if ('animations' in entity) {
    const anims = entity.animations;
    if (!isRecord(anims)) {
      errors.push(`${path}.animations: ожидался объект, получено ${typeName(anims)}`);
    } else {
      checkUnknownKeys(anims, ['states', 'events'], `${path}.animations`, errors);
      if ('states' in anims) {
        validateStringMap(anims.states, `${path}.animations.states`, 'состояние → подстрока имени клипа', errors);
      }
      if ('events' in anims) {
        validateStringMap(anims.events, `${path}.animations.events`, 'событие → подстрока имени клипа', errors);
      }
    }
  }

  if ('boneControls' in entity) {
    const controls = entity.boneControls;
    if (!isRecord(controls)) {
      errors.push(`${path}.boneControls: ожидался объект «роль → параметры», получено ${typeName(controls)}`);
    } else {
      for (const [role, control] of Object.entries(controls)) {
        const rolePath = `${path}.boneControls.${role}`;
        if (!isRecord(control)) {
          errors.push(`${rolePath}: ожидался объект { bone, maxYawDeg, smoothing }, получено ${typeName(control)}`);
          continue;
        }
        checkUnknownKeys(control, ['bone', 'maxYawDeg', 'smoothing'], rolePath, errors);
        if (typeof control.bone !== 'string' || control.bone.length === 0) {
          errors.push(`${rolePath}.bone: обязательное поле — имя кости (непустая строка)`);
        }
        if (!isFiniteNumber(control.maxYawDeg) || control.maxYawDeg < 0) {
          errors.push(`${rolePath}.maxYawDeg: ожидалось неотрицательное число градусов`);
        }
        if (!isFiniteNumber(control.smoothing) || control.smoothing < 0) {
          errors.push(`${rolePath}.smoothing: ожидалось неотрицательное число`);
        }
      }
    }
  }

  if ('hiddenParts' in entity) {
    const hidden = entity.hiddenParts;
    if (!Array.isArray(hidden)) {
      errors.push(`${path}.hiddenParts: ожидался массив индексов частей модели, получено ${typeName(hidden)}`);
    } else {
      hidden.forEach((g, i) => {
        if (!Number.isInteger(g) || (g as number) < 0) {
          errors.push(`${path}.hiddenParts[${i}]: ожидался целый индекс части модели >= 0, получено ${typeName(g)}`);
        }
      });
    }
  }
}

/**
 * Секция эффектов камеры (ASSET-7). Структура проверяется строго (typo —
 * ошибка), но сам тип эффекта — нет: неизвестный тип валиден для манифеста
 * и отбраковывается предупреждением на потребителе (камера переживает
 * запись из будущего кода). Параметры, кроме `effect`, — конечные числа.
 */
function validateCameraEffects(section: unknown, errors: string[]): void {
  const path = 'cameraEffects';
  if (!isRecord(section)) {
    errors.push(`${path}: ожидался объект { events?, states? }, получено ${typeName(section)}`);
    return;
  }
  checkUnknownKeys(section, ['events', 'states'], path, errors);
  for (const table of ['events', 'states'] as const) {
    if (!(table in section)) continue;
    const entries = section[table];
    if (!isRecord(entries)) {
      errors.push(`${path}.${table}: ожидался объект «имя → эффект», получено ${typeName(entries)}`);
      continue;
    }
    for (const [name, def] of Object.entries(entries)) {
      const defPath = `${path}.${table}.${name}`;
      if (!isRecord(def)) {
        errors.push(`${defPath}: ожидался объект { effect, …параметры }, получено ${typeName(def)}`);
        continue;
      }
      if (typeof def.effect !== 'string' || def.effect.length === 0) {
        errors.push(`${defPath}.effect: обязательное поле — тип эффекта (непустая строка)`);
      }
      for (const [param, value] of Object.entries(def)) {
        if (param === 'effect') continue;
        if (!isFiniteNumber(value)) {
          errors.push(`${defPath}.${param}: параметр эффекта — конечное число, получено ${typeName(value)}`);
        }
      }
    }
  }
}

/**
 * Валидация документа манифеста (ASSET-6, ASSET-7). Ошибки собираются все
 * разом (не fail-fast), каждая — с путём до поля, чтобы правка JSON не
 * превращалась в угадывание. Успех возвращает документ, типизированный как
 * VisualManifest.
 */
export function validateManifest(
  doc: unknown,
): { ok: true; manifest: VisualManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`манифест: ожидался объект, получено ${typeName(doc)}`] };
  }
  checkUnknownKeys(doc, ['entities', 'surfaceAlign', 'terrain', 'cameraEffects'], 'манифест', errors);
  if (!isRecord(doc.entities)) {
    errors.push(`entities: обязательное поле — объект «prefab → визуал», получено ${typeName(doc.entities)}`);
  } else {
    for (const [name, entity] of Object.entries(doc.entities)) {
      validateEntity(entity, `entities.${name}`, errors);
    }
  }
  if ('cameraEffects' in doc) validateCameraEffects(doc.cameraEffects, errors);
  if ('surfaceAlign' in doc) {
    validateSurfaceAlign(doc.surfaceAlign, 'surfaceAlign', errors);
  }
  if ('terrain' in doc) {
    if (!isRecord(doc.terrain)) {
      errors.push(`terrain: ожидался объект, получено ${typeName(doc.terrain)}`);
    } else {
      checkUnknownKeys(doc.terrain, ['curvatureMap'], 'terrain', errors);
      if (
        'curvatureMap' in doc.terrain &&
        (typeof doc.terrain.curvatureMap !== 'string' || doc.terrain.curvatureMap.length === 0)
      ) {
        errors.push(
          `terrain.curvatureMap: ожидался asset id карты кривизны (непустая строка), получено ${typeName(doc.terrain.curvatureMap)}`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: doc as unknown as VisualManifest };
}
