/**
 * @contribution Строки инспектора для секций VFX манифеста визуалов (ED-14):
 * транзиентных эффектов (`assets` ASSET-6, `rendering` REND-23) и эмиттеров
 * частиц (ASSET-14, REND-24). Вклад в область просмотрщика (ED-25), а не часть
 * каркаса.
 *
 * ED-14 читается буквально: «Ручная правка манифеста MUST NOT быть
 * обязательной». Операции этих секций (`assetVfx.ts`) появились раньше панели,
 * и без неё автор звал их только из кода — то есть правил `manifest.json`
 * руками. Здесь тот же набор действий, что у секции эффектов камеры: выбрать
 * источник, править его числа, завести новый, снять ненужный.
 *
 * ## Отдельным модулем, а не строками в `assets.ts`
 *
 * Область просмотрщика уже отдала свои части соседям (`assetTree`,
 * `assetPreview`, `assetModule`, `assetVisuals`, `assetCameraEffects`), и её
 * шапка прямо говорит: остаток — три зоны над одной записью состояния. Секции
 * VFX — четвёртый крупный блок, и класть его туда значило бы вернуть в файл то,
 * что из него уже вынесли.
 *
 * Состояние при этом остаётся ОДНО (ED-23): черновик секций живёт в записи
 * области, а модуль объявляет ровно ту его часть, которую читает
 * ({@link VfxAreaState}). Обратной ссылки на область у него нет — иначе получился
 * бы цикл модулей, который архитектурное правило репозитория запрещает.
 *
 * ## Ни перечня примитивов, ни состава полей записи здесь нет
 *
 * Имена примитивов принадлежат рендеру (REND-23), состав полей записи — модулю
 * ассетов (ASSET-6), и своих копий этих перечней панель не заводит: она правит
 * то, что в записи ЛЕЖИТ, а неизвестный ключ и негодное число называет владелец
 * — отказом операции (`assetVfx.ts` спрашивает `validateManifest` о разнице).
 * Список {@link FIELD_SUGGESTIONS} — ПОДСКАЗКА для дописывания поля, того же
 * рода, что подсказка имён событий у соседней секции: он вправе отстать от
 * формата, и отставание дефектом не является — набрать имя руками автор может
 * всегда, а проверит его владелец.
 */
import type { DocumentId, JsonValue, OperationParams } from '@fluxus/editor-core';
import { validateManifest } from '@fluxus/assets';
import { documentValue, resourceText, type UiText } from '../dom/node.js';
import type { AreaContext } from '../frame/area.js';
import { runOperation, type AreaChromeState } from '../frame/areaChrome.js';
import { button } from '../widgets/button.js';
import { numberField, select, textField } from '../widgets/field.js';
import type { FieldRowSpec } from '../widgets/fieldTable.js';
import {
  VFX_OPERATIONS,
  effectImages,
  emitterOf,
  vfxSourceNames,
} from './assetVfx.js';

/** Снятие источника — общей операцией: своей у него нет (`assetVfx.ts`). */
const REMOVE_VALUE_OPERATION = 'document.removeValue';

/** Где в манифесте лежат секции (ASSET-6, ASSET-14) — то же знание, что у операций. */
const EFFECTS_SECTION = 'effects';
const PARTICLES_SECTION = 'particles';

/** Таблицы источников: те же три у обеих секций (REND-23, REND-24). */
const DEFAULT_TABLE = 'byKind';
export const VFX_TABLES: readonly string[] = Object.freeze([DEFAULT_TABLE, 'byState', 'byEvent']);

/** Ключ подписи таблицы: имя таблицы — часть ключа, а не подставляемый текст. */
export const TABLE_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({
  byKind: 'ui.area.assets.vfxByKind',
  byState: 'ui.area.assets.vfxByState',
  byEvent: 'ui.area.assets.vfxByEvent',
});

/**
 * Поля записи изображения, которые панель ПРЕДЛАГАЕТ дописать. Подсказка, а не
 * правило (см. шапку): состав записи закрыт валидацией манифеста, и она же
 * назовёт ключ, которого в формате нет. Порядок смысловой — от того, что есть у
 * всякой записи, к числам формы отдельных примитивов (REND-43).
 */
const FIELD_SUGGESTIONS: readonly string[] = Object.freeze([
  'color',
  'radius',
  'radiusTo',
  'alpha',
  'alphaTo',
  'durationMs',
  'curve',
  'height',
  'offset',
  'innerRadius',
  'halfAngleDeg',
  'length',
  'width',
  'edgeSoftness',
  'lift',
  'trailSamples',
  'targetFromStat',
]);

/** Поля записи, которые пишутся СТРОКОЙ; прочие — числами. */
const TEXT_FIELDS: readonly string[] = Object.freeze([
  'primitive',
  'color',
  'curve',
  'targetFromStat',
]);

/**
 * Часть записи области, которую читает панель (ED-23). Объявлена здесь, а не
 * взята из области: модуль обязан обходиться без ссылки на неё.
 */
export interface VfxAreaState extends AreaChromeState {
  /** ID документа манифеста; `null` — он ещё не открыт. */
  visualsId: DocumentId | null;
  /** Таблица источников, с которой работает автор (REND-23, REND-24). */
  vfxTable: string;
  /** Выбранный источник — субъект полей ниже; `''` — не выбран. */
  vfxSource: string;
  /** Номер выбранного изображения внутри источника (REND-23: их бывает несколько). */
  vfxImage: number;
  /** Черновики: имя заводимого источника и первые числа его изображения. */
  vfxName: string;
  vfxPrimitive: string;
  vfxColor: string;
  /**
   * Радиус и ширина черновика — ДВА поля, а не одно: какое из них обязательно
   * примитиву, решает формат (ASSET-6), и писать оба значило бы класть в
   * документ лишнее поле (ED-21).
   */
  vfxRadius: string;
  vfxWidth: string;
  /** Черновик привязки эмиттера: ID эмиттерного ассета (ASSET-14). */
  vfxAsset: string;
  /** Имя поля, которое автор дописывает выбранному изображению. */
  vfxField: string;
}

/** Начальный черновик секций: панель ничего не выбрала и ничего не набрала. */
export function vfxDraftState(): Omit<VfxAreaState, keyof AreaChromeState | 'visualsId'> {
  return {
    vfxTable: DEFAULT_TABLE,
    vfxSource: '',
    vfxImage: 0,
    vfxName: '',
    vfxPrimitive: '',
    vfxColor: '',
    vfxRadius: '',
    vfxWidth: '',
    vfxAsset: '',
    vfxField: '',
  };
}

export type VfxContext = AreaContext<VfxAreaState>;
type Context = VfxContext;

/** Правка секции идёт операцией и только ей (ED-29); отказ показывает каркас (ED-30). */
export function vfxOperation(context: Context, operationId: string, params: OperationParams): void {
  const id = context.state.visualsId;
  if (id === null) return;
  runOperation(context, operationId, { document: id, ...params });
}

/** Значение открытого манифеста; `undefined` — документа нет или он не открыт. */
function manifestValue(context: Context): JsonValue | undefined {
  const { state, session } = context;
  const id = state.visualsId;
  if (id === null || !session.isOpen(id)) return undefined;
  return session.documentValue(id);
}

/**
 * Находки валидации, адресованные ЭТОМУ источнику (ED-8). Спрашивается тот же
 * `validateManifest`, которым документ проверяется на загрузке: второй копии
 * правил у панели нет, а показать находку рядом с полем — ровно то, чего ED-8
 * требует от правки в реальном времени.
 */
function sourceFindings(
  value: JsonValue | undefined,
  section: string,
  table: string,
  name: string,
): string {
  if (value === undefined) return '';
  const checked = validateManifest(value);
  if (checked.ok) return '';
  const prefix = `${section}.${table}.${name}`;
  return checked.errors.filter((error) => error.startsWith(prefix)).join('; ');
}

/** Подпись пункта списка изображений: номер записи и имя её примитива. */
function imageLabel(index: number, primitive: JsonValue | undefined): string {
  const shown = valueText(primitive);
  return shown === '' ? String(index) : `${String(index)} ${shown}`;
}

/** Составное ли значение поля: окно стата, порог цвета, вертикальное смещение. */
function composite(value: JsonValue | undefined): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * Значение поля записи строкой. Составное показывается своим JSON и ТОЛЬКО для
 * чтения (см. {@link fieldControl}): у него своя форма, и текстовое поле для
 * него — не редактор, а способ сломать документ. Правится оно операцией
 * (`assetVfx.ts` принимает значение поля объектом целиком).
 */
function valueText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (composite(value)) return JSON.stringify(value);
  return '';
}

/** Находка источника состоянием контрола; `undefined` — находок нет. */
function findingState(reason: string): { severity: 'error'; reason: UiText } | undefined {
  return reason === '' ? undefined : { severity: 'error', reason: documentValue(reason) };
}

// ------------------------------------------------ изображения эффектов (REND-23)

/**
 * Таблица источников секции эффектов: у каждого — свои изображения (REND-23).
 * Выбранный источник раскрывается полями своего изображения, потому что полей
 * этих десятки, а показывать их у всех источников сразу значило бы сделать
 * инспектор нечитаемым — тот же приём, что у секции эффектов камеры.
 */
export function vfxEffectRows(context: Context): readonly FieldRowSpec[] {
  const { state, resources } = context;
  const value = manifestValue(context);
  if (value === undefined) return [];
  const table = state.vfxTable;
  const off = context.mode === 'preview';
  const rows: FieldRowSpec[] = [];
  for (const name of vfxSourceNames(value, EFFECTS_SECTION, table)) {
    const images = effectImages(value, table, name);
    const selected = state.vfxSource === name;
    const finding = findingState(sourceFindings(value, EFFECTS_SECTION, table, name));
    rows.push({
      label: documentValue(name),
      // Выбор изображения он же и выбор источника: у источника с одной записью
      // список из одного пункта, и различать две формы автору незачем (REND-23).
      control: select({
        label: documentValue(name),
        value: selected ? String(state.vfxImage) : '',
        options: [
          { value: '', label: resourceText(resources, 'ui.area.assets.none') },
          ...images.map((image, index) => ({
            value: String(index),
            // Подпись пункта — ДОКУМЕНТНАЯ: номер записи и её примитив. Ни то,
            // ни другое не локализуется (ED-27), поэтому и собирается строкой.
            label: documentValue(imageLabel(index, image.primitive)),
          })),
        ],
        disabled: off,
        ...(finding === undefined ? {} : { validation: finding }),
        onSelect: (next) => {
          state.vfxSource = next === '' ? '' : name;
          state.vfxImage = next === '' ? 0 : Number(next);
          context.refresh();
        },
      }),
      note: documentValue(String(images.length)),
    });
    if (selected) rows.push(...imageRows(context, name, images.length));
  }
  return rows;
}

/** Поля выбранного изображения плюс дописывание поля и снятие изображения. */
function imageRows(context: Context, name: string, count: number): readonly FieldRowSpec[] {
  const { state, resources } = context;
  const value = manifestValue(context);
  const image = effectImages(value, state.vfxTable, name)[state.vfxImage];
  if (image === undefined) return [];
  const off = context.mode === 'preview';
  const rows: FieldRowSpec[] = Object.keys(image).map((field) => ({
    label: documentValue(field),
    control: fieldControl(context, name, field, image[field]),
  }));
  rows.push({
    label: resourceText(resources, 'ui.area.assets.vfxField'),
    control: select({
      label: resourceText(resources, 'ui.area.assets.vfxField'),
      value: state.vfxField,
      options: [
        { value: '', label: resourceText(resources, 'ui.area.assets.none') },
        ...FIELD_SUGGESTIONS.filter((field) => !(field in image)).map((field) => ({
          value: field,
          label: documentValue(field),
        })),
      ],
      disabled: off,
      onSelect: (next) => {
        state.vfxField = next;
        context.refresh();
      },
    }),
  });
  if (state.vfxField !== '' && !(state.vfxField in image)) {
    rows.push({
      label: documentValue(state.vfxField),
      control: fieldControl(context, name, state.vfxField, undefined),
    });
  }
  rows.push({
    label: resourceText(resources, 'ui.area.assets.vfxRemoveImage'),
    control: button({
      label: resourceText(resources, 'ui.area.assets.vfxRemoveImage'),
      variant: 'ghost',
      disabled: off,
      onPress: () => {
        // Последнее изображение снимается ВМЕСТЕ с источником: пустой список
        // формат отвергает (REND-23), и оставлять автора с заведомо невалидным
        // документом ради буквальности действия незачем.
        const path =
          count > 1
            ? [EFFECTS_SECTION, state.vfxTable, name, state.vfxImage]
            : [EFFECTS_SECTION, state.vfxTable, name];
        vfxOperation(context, REMOVE_VALUE_OPERATION, { path });
        state.vfxSource = '';
        state.vfxImage = 0;
      },
    }),
  });
  return rows;
}

/**
 * Контрол одного поля записи: строковые поля пишутся текстом, прочие — числом.
 * Пустая строка СНИМАЕТ поле (`null` операции): без снятия автор чистил бы
 * документ руками, чего ED-14 не допускает.
 */
function fieldControl(
  context: Context,
  name: string,
  field: string,
  current: JsonValue | undefined,
): ReturnType<typeof textField> {
  const { state } = context;
  const text = TEXT_FIELDS.includes(field);
  const shown = valueText(current);
  // Составное значение видно, но не правится: подменить объект строкой из этого
  // поля значило бы сломать запись жестом, который выглядит как правка числа.
  const locked = context.mode === 'preview' || composite(current);
  const commit = (raw: string): void => {
    const trimmed = raw.trim();
    if (trimmed === shown) return;
    // Число и строка различаются ЗДЕСЬ, а не в операции: операция принимает
    // любое значение JSON, а годность его называет владелец формата (ASSET-6).
    let next: JsonValue | null = null;
    if (trimmed !== '') {
      if (text) next = trimmed;
      else {
        const parsed = Number(trimmed);
        if (Number.isNaN(parsed)) return;
        next = parsed;
      }
    }
    vfxOperation(context, VFX_OPERATIONS.setField, {
      table: state.vfxTable,
      name,
      index: state.vfxImage,
      field,
      value: next,
    });
  };
  const spec = {
    label: documentValue(field),
    value: documentValue(shown),
    readOnly: locked,
    onCommit: commit,
  };
  return text ? textField(spec) : numberField(spec);
}

// ------------------------------------------------- эмиттеры частиц (REND-24)

/** Необязательные части записи эмиттера (ASSET-14): узел-сокет и масштаб. */
const EMITTER_PARTS: readonly { readonly key: 'socket' | 'scale'; readonly labelKey: string }[] =
  Object.freeze([
    { key: 'socket', labelKey: 'ui.area.assets.vfxSocket' },
    { key: 'scale', labelKey: 'ui.area.assets.vfxScale' },
  ]);

/**
 * Таблица источников секции эмиттеров (ASSET-14): у каждого одна запись —
 * ссылка на эмиттерный ассет, необязательный узел-сокет и множитель масштаба.
 * Пишется она ЦЕЛИКОМ (`assetVfx.ts`), поэтому каждая строка отдаёт операции
 * все три значения, а не своё одно.
 */
export function vfxParticleRows(context: Context): readonly FieldRowSpec[] {
  const value = manifestValue(context);
  if (value === undefined) return [];
  const table = context.state.vfxTable;
  const rows: FieldRowSpec[] = [];
  for (const name of vfxSourceNames(value, PARTICLES_SECTION, table)) {
    rows.push(...emitterRows(context, value, name));
  }
  return rows;
}

/** Три поля записи эмиттера и снятие привязки — над одним источником. */
function emitterRows(
  context: Context,
  value: JsonValue,
  name: string,
): readonly FieldRowSpec[] {
  const { resources } = context;
  const table = context.state.vfxTable;
  const off = context.mode === 'preview';
  const record = emitterOf(value, table, name) ?? {};
  const asset = typeof record.effect === 'string' ? record.effect : '';
  const socket = typeof record.socket === 'string' ? record.socket : '';
  const scale = typeof record.scale === 'number' ? String(record.scale) : '';
  const finding = findingState(sourceFindings(value, PARTICLES_SECTION, table, name));
  // Запись пишется ЦЕЛИКОМ (`assetVfx.ts`), поэтому каждая правка отдаёт
  // операции все три значения, а не своё одно.
  const write = (next: { asset?: string; socket?: string; scale?: string }): void => {
    const nextScale = next.scale ?? scale;
    const parsed = Number(nextScale);
    vfxOperation(context, VFX_OPERATIONS.setEmitter, {
      table,
      name,
      asset: next.asset ?? asset,
      ...((next.socket ?? socket) === '' ? {} : { socket: next.socket ?? socket }),
      ...(nextScale === '' || Number.isNaN(parsed) ? {} : { scale: parsed }),
    });
  };
  const rows: FieldRowSpec[] = [
    {
      label: documentValue(name),
      control: textField({
        label: documentValue(name),
        value: documentValue(asset),
        readOnly: off,
        ...(finding === undefined ? {} : { validation: finding }),
        onCommit: (raw) => {
          if (raw.trim() !== asset) write({ asset: raw.trim() });
        },
      }),
      note: resourceText(resources, 'ui.area.assets.vfxEffectAsset'),
    },
  ];
  // Сокет и масштаб — одинаковые строки над одной записью, и потому строятся
  // перечнем: три копии одного обработчика расходятся по одной за раз.
  for (const part of EMITTER_PARTS) {
    const shown = part.key === 'socket' ? socket : scale;
    rows.push({
      label: resourceText(resources, part.labelKey),
      control: (part.key === 'socket' ? textField : numberField)({
        label: resourceText(resources, part.labelKey),
        value: documentValue(shown),
        readOnly: off,
        onCommit: (raw) => {
          if (raw.trim() !== shown) write({ [part.key]: raw.trim() });
        },
      }),
    });
  }
  rows.push({
    label: resourceText(resources, 'ui.area.assets.vfxRemoveEmitter'),
    control: button({
      label: resourceText(resources, 'ui.area.assets.vfxRemoveEmitter'),
      variant: 'ghost',
      disabled: off,
      onPress: () => {
        vfxOperation(context, REMOVE_VALUE_OPERATION, { path: [PARTICLES_SECTION, table, name] });
      },
    }),
  });
  return rows;
}
