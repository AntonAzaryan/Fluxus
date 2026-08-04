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
}

export interface EntityVisual {
  /** Asset id модели. */
  model: string;
  /** Мировая высота юнита; по умолчанию 1. */
  scale?: number;
  defaultSkin?: string;
  /** Имя скина → (номер textureSlot как строка → asset id текстуры). */
  skins?: Record<string, Record<string, string>>;
  /** 'idle'/'move' → подстрока имени клипа; имя события → подстрока имени клипа. */
  animations?: { states?: Record<string, string>; events?: Record<string, string> };
  /** Роль ('torso', 'head') → параметры процедурного контроля кости (REND-5). */
  boneControls?: Record<string, { bone: string; maxYawDeg: number; smoothing: number }>;
  /** Индексы частей модели (`NormalizedMesh.partId`), исключаемых из рендера. */
  hiddenParts?: number[];
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

function validateEntity(entity: unknown, path: string, errors: string[]): void {
  if (!isRecord(entity)) {
    errors.push(`${path}: ожидался объект визуала, получено ${typeName(entity)}`);
    return;
  }
  checkUnknownKeys(
    entity,
    ['model', 'scale', 'defaultSkin', 'skins', 'animations', 'boneControls', 'hiddenParts'],
    path,
    errors,
  );

  if (typeof entity.model !== 'string' || entity.model.length === 0) {
    errors.push(`${path}.model: обязательное поле — непустая строка (asset id модели)`);
  }

  if ('scale' in entity && (!isFiniteNumber(entity.scale) || entity.scale <= 0)) {
    errors.push(`${path}.scale: ожидалось положительное число, получено ${typeName(entity.scale)}`);
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
 * Валидация документа манифеста (ASSET-6). Ошибки собираются все разом (не
 * fail-fast), каждая — с путём до поля, чтобы правка JSON не превращалась в
 * угадывание. Успех возвращает документ, типизированный как VisualManifest.
 */
export function validateManifest(
  doc: unknown,
): { ok: true; manifest: VisualManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`манифест: ожидался объект, получено ${typeName(doc)}`] };
  }
  checkUnknownKeys(doc, ['entities'], 'манифест', errors);
  if (!isRecord(doc.entities)) {
    errors.push(`entities: обязательное поле — объект «prefab → визуал», получено ${typeName(doc.entities)}`);
  } else {
    for (const [name, entity] of Object.entries(doc.entities)) {
      validateEntity(entity, `entities.${name}`, errors);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: doc as unknown as VisualManifest };
}
