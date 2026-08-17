/**
 * Пресеты качества картинки демо (`render-quality` QUAL-1, design D3, D4).
 *
 * ## Почему документы живут здесь
 *
 * Ручки объявляет движок, значения им даёт ИГРА (QUAL-1, design D4): три
 * документа `presets/*.json` — политика этого приложения, и другая игра на том
 * же движке привезёт свои. Кода рендера имена «производительность / баланс /
 * ультра» не касаются вовсе: контроллеру дают документ, а не название.
 *
 * ## Что в документах написано
 *
 * - `balanced` — СЕГОДНЯШНЕЕ поведение слово в слово: все ручки на своих
 *   документированных умолчаниях, потолков нет. Написаны они явно, а не
 *   пропущены: «здесь ничего не ограничено» — решение, и читаться оно должно
 *   в документе, а не выводиться из пустого объекта.
 * - `performance` — первые реальные ограничения. Потолок (design D3) —
 *   `min(авторское, потолок)`, поэтому документы сцены и манифеста он не
 *   правит ни байтом:
 *   - `fog.maskResolution` 4 при сценных 8 (FOW-10) — вчетверо меньше текселей
 *     маски; ровно тот рычаг, которого не хватило правке 4 → 8 (proposal «Why»).
 *     Информации игроку это не меняет (QUAL-2): круг видимости остаётся
 *     консервативным (FOW-9), а сущностей за туманом в снапшоте нет (NET-12);
 *   - `terrain.curvatureTessellation` 2 при умолчании конфига рендера 4
 *     (REND-9) — вчетверо меньше подклеток на клетку с кривизной. Не 4: потолок,
 *     равный действующему значению, не ограничивает сегодня ничего;
 *   - `models.lodThresholdScale` 2 (REND-22) — грубый уровень включается вдвое
 *     раньше по экранному размеру; пороги записи манифеста (ASSET-13) остаются
 *     авторскими, множитель читает их;
 *   - `models.defaultTier` `batched` (REND-20) — дешёвый носитель закреплён
 *     явно, чтобы смена умолчания движка не подняла бюджет слабых устройств
 *     молча;
 *   - `particles.density` 0.5 (REND-24) — вдвое меньше живых частиц у каждого
 *     эмиттера; какие эмиттеры существуют, решает контент, а не пресет.
 * - `ultra` — авторский потолок как есть, и сегодня поднимать ему НЕЧЕГО:
 *   единственная ручка, способная дать больше умолчания, — `models.defaultTier`,
 *   а детальный ярус по умолчанию сменил бы носителя тому, что демо показывает
 *   сейчас. Герой и так детальный (у записи `Hero` есть `boneControls`, REND-5),
 *   а ярус по умолчанию наследует ровно одна запись — декорация `Statue`, и она
 *   рисуется батчевым ярусом. Поэтому `ultra` визуально равен `balanced`, пока
 *   ярус не назовёт сам автор записи манифеста (`tier`, ASSET-13); числа
 *   документов — политика, правится без изменения спеки.
 */
import {
  QualityController,
  validateQualityPreset,
  type PresentationStage,
  type QualityPreset,
} from '@game-mvp/render';
import performanceJson from './presets/performance.json';
import balancedJson from './presets/balanced.json';
import ultraJson from './presets/ultra.json';

/** Уровни качества демо — набор игры, а не движка (QUAL-1). */
export const QUALITY_PRESET_NAMES = ['performance', 'balanced', 'ultra'] as const;

export type QualityPresetName = (typeof QUALITY_PRESET_NAMES)[number];

/** Дефолт демо (design D4): то же поведение, что было до появления пресетов. */
export const DEFAULT_QUALITY_PRESET: QualityPresetName = 'balanced';

/** Документы пресетов по именам — вход контроллера качества. */
export const QUALITY_PRESETS: Readonly<Record<QualityPresetName, QualityPreset>> = {
  performance: performanceJson,
  balanced: balancedJson,
  ultra: ultraJson,
};

/** Ключ хранения выбора; выбор переживает перезагрузку страницы, а не матч. */
export const QUALITY_STORAGE_KEY = 'demo.quality';

/**
 * Имя пресета из чего угодно: незнакомое (чужая запись, документ, которого
 * больше нет, пустое хранилище) — дефолт демо, а не отказ. Выбор качества
 * картинки не тот повод, чтобы не пустить человека в матч.
 */
export function qualityPresetName(stored: string | null | undefined): QualityPresetName {
  const known = QUALITY_PRESET_NAMES.find((name) => name === stored);
  return known ?? DEFAULT_QUALITY_PRESET;
}

/** Что демо нужно от хранилища выбора — две операции, и ни одной сверх них. */
export interface QualityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Хранилище выбора, если оно в этой среде есть. Тем же вопросом к среде, что и
 * мост десктопа (`desktopStand.ts`): прогон тестов идёт в Node, где
 * `localStorage` нет вовсе, и обращение к нему было бы не деградацией, а
 * падением на импорте.
 */
export function qualityStorageOf(scope: unknown): QualityStorage | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined;
  let candidate: unknown;
  try {
    candidate = (scope as { localStorage?: unknown }).localStorage;
  } catch {
    // Запрет доступа браузер выдаёт на самом обращении к свойству (приватный
    // режим, запрещённые куки): «хранилища нет» — такая же нормальная среда,
    // как воркер или прогон в Node.
    return undefined;
  }
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const storage = candidate as Partial<QualityStorage>;
  if (typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    return undefined;
  }
  return storage as QualityStorage;
}

/**
 * Запомненный выбор; нет хранилища или записи — дефолт демо. Само обращение к
 * хранилищу браузер вправе отклонить (приватный режим, запрещённые куки), и
 * отказ здесь значит «выбора не запомнено», а не «страница сломалась».
 */
export function storedQualityPreset(storage: QualityStorage | undefined): QualityPresetName {
  if (storage === undefined) return DEFAULT_QUALITY_PRESET;
  try {
    return qualityPresetName(storage.getItem(QUALITY_STORAGE_KEY));
  } catch {
    return DEFAULT_QUALITY_PRESET;
  }
}

/** Запомнить выбор. Отказ хранилища молчалив: качество картинки уже применено. */
export function rememberQualityPreset(
  storage: QualityStorage | undefined,
  name: QualityPresetName,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(QUALITY_STORAGE_KEY, name);
  } catch {
    // Пусто намеренно: не запомнить выбор — не повод ломать кадр.
  }
}

export interface DemoQualityOptions {
  /** С чего начать; незнакомое имя и отсутствие — дефолт демо. */
  readonly preset?: QualityPresetName;
  /** Куда громко сказать об отвергнутом документе; по умолчанию — консоль. */
  readonly warn?: (message: string) => void;
}

export interface DemoQuality {
  /** Контроллер качества сцены (QUAL-1): им и раздаются значения ручек. */
  readonly controller: QualityController;
  /** Действующий пресет — выбранный либо запасной, если выбранный отвергнут. */
  readonly current: QualityPresetName;
  /** Смена пресета в рантайме (design D2); возвращает действующее имя. */
  select(name: QualityPresetName): QualityPresetName;
}

/**
 * Контроллер качества над собранной сценой демо (QUAL-1, design D2). Зовётся
 * ПОСЛЕ регистрации подсистем: состав документа проверяется против собранного
 * реестра (design D1), и ручка ещё не зарегистрированной подсистемы была бы
 * «неизвестной» только по порядку сборки.
 *
 * Каждый документ проверяется здесь ОДИН раз, а не при каждом переключении:
 * отвергнутый — громкая ошибка в консоли с именем документа и причиной, а не
 * молчаливый пропуск, и переключиться на него больше нельзя — действует
 * запасной `balanced` (design D4).
 */
export function createDemoQuality(
  stage: PresentationStage,
  options: DemoQualityOptions = {},
): DemoQuality {
  const warn =
    options.warn ??
    ((message: string): void => {
      console.error(message);
    });
  const controller = new QualityController(stage);
  const refused = new Set<QualityPresetName>();
  for (const name of QUALITY_PRESET_NAMES) {
    const result = validateQualityPreset(QUALITY_PRESETS[name], controller.knobs);
    if (result.ok) continue;
    refused.add(name);
    warn(
      `демо: документ пресета качества "${name}" отвергнут реестром ручек (QUAL-1) — ` +
        result.errors.join('; '),
    );
  }

  let current: QualityPresetName = DEFAULT_QUALITY_PRESET;
  const apply = (name: QualityPresetName): QualityPresetName => {
    const chosen = refused.has(name) ? DEFAULT_QUALITY_PRESET : name;
    if (refused.has(chosen)) {
      // Негоден и запасной: ручки остаются на умолчаниях движка (QUAL-1) —
      // это ровно то, что описывает `balanced`, но сказать об этом надо вслух.
      warn(
        `демо: пресет качества "${name}" применить нечем — ручки остаются на умолчаниях движка (QUAL-1)`,
      );
      return current;
    }
    if (chosen !== name) {
      warn(`демо: пресет качества "${name}" отвергнут — действует запасной "${chosen}"`);
    }
    controller.apply(QUALITY_PRESETS[chosen]);
    current = chosen;
    return chosen;
  };
  apply(options.preset ?? DEFAULT_QUALITY_PRESET);

  return {
    controller,
    get current(): QualityPresetName {
      return current;
    },
    select: apply,
  };
}
