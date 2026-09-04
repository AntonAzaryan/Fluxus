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
 *
 * Список полей, которые панель предлагает дописать, и род контрола у каждой
 * строки приходят ОТТУДА ЖЕ — машинным описанием состава записи
 * (`EFFECT_FIELDS` модуля ассетов): своего списка у панели нет ни в каком виде,
 * и отстать от формата ей поэтому нечем. Основание то же, по которому набор
 * типов эффектов камеры приезжает описанием (CAM-9), и ровно этого ED-14 требует
 * прямым текстом.
 */
import { isJsonObject, type DocumentId, type JsonValue, type OperationParams } from '@fluxus/editor-core';
import { EFFECT_FIELDS, validateManifest, type ManifestFieldSpec } from '@fluxus/assets';
import { documentValue, resourceText } from '../dom/node.js';
import type { AreaContext } from '../frame/area.js';
import { runOperation, type AreaChromeState } from '../frame/areaChrome.js';
import { button } from '../widgets/button.js';
import { numberField, select, textField } from '../widgets/field.js';
import type { FieldRowSpec } from '../widgets/fieldTable.js';
import type { ValidationState } from '../widgets/validation.js';
import {
  VFX_OPERATIONS,
  effectImageAddress,
  effectImages,
  emitterOf,
  vfxSourceNames,
} from './assetVfx.js';
import { vfxCompositeRows } from './assetVfxComposite.js';

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
 * Описание поля записи по его имени (ASSET-6) — им панель выбирает контрол
 * строки. Карта строится один раз из описания владельца: своего перечня полей у
 * панели нет, а искать по списку на каждой строке инспектора незачем.
 *
 * `undefined` в ответе — поле, которого описание НЕ называет. Такое в записи
 * бывает (опечатка автора, документ новее кода), и панель его показывает: она
 * правит то, что в записи лежит, а неизвестный ключ называет владелец.
 */
const FIELD_SPECS: ReadonlyMap<string, ManifestFieldSpec> = new Map(
  EFFECT_FIELDS.map((spec) => [spec.name, spec]),
);

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
  /**
   * Черновик подполей составного поля (REND-23: окно стата, порог цвета,
   * мигание): «поле.подполе» → набранный текст. Составное поле пишется целиком,
   * и до нажатия «записать» набранное живёт здесь, а не в документе.
   */
  vfxComposite: Record<string, string>;
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
    vfxComposite: {},
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

/** Находка состоянием контрола; `undefined` — находок нет. */
function findingState(reason: string): ValidationState | undefined {
  return reason === '' ? undefined : { severity: 'error', reason: documentValue(reason) };
}

/**
 * Находки документа, адресованные полям ВЫБРАННОГО изображения (ED-8): каждая
 * встаёт у своей строки, а не одной кучей у источника. Документ проверяется
 * один раз на всё изображение — спрашивать владельца построчно значило бы
 * проверять манифест десятки раз за кадр.
 *
 * Адрес изображения знает модуль операций (`effectImageAddress`): у
 * источника-списка находка адресована номером записи, и второго чтения формы
 * источника здесь не заводится.
 */
function imageFindings(
  context: Context,
  name: string,
): (field: string) => ValidationState | undefined {
  const value = manifestValue(context);
  if (value === undefined) return () => undefined;
  const checked = validateManifest(value);
  if (checked.ok) return () => undefined;
  const prefix = `${effectImageAddress(value, context.state.vfxTable, name, context.state.vfxImage)}.`;
  return (field) =>
    findingState(checked.errors.filter((error) => error.startsWith(`${prefix}${field}: `)).join('; '));
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
  const finding = imageFindings(context, name);
  const rows: FieldRowSpec[] = [];
  for (const field of Object.keys(image)) {
    rows.push(...fieldRows(context, name, field, image[field], finding));
  }
  rows.push({
    label: resourceText(resources, 'ui.area.assets.vfxField'),
    control: select({
      label: resourceText(resources, 'ui.area.assets.vfxField'),
      // Что предложить дописать, говорит описание состава записи (ASSET-6), а
      // не список панели: порядок пунктов — его смысловой порядок, и новое поле
      // формата появляется здесь само.
      value: state.vfxField,
      options: [
        { value: '', label: resourceText(resources, 'ui.area.assets.none') },
        ...EFFECT_FIELDS.filter((spec) => !(spec.name in image)).map((spec) => ({
          value: spec.name,
          label: documentValue(spec.name),
        })),
      ],
      disabled: off,
      onSelect: (next) => {
        state.vfxField = next;
        // Черновик подполей принадлежит выбранному полю: оставь его от
        // прежнего — и автор записал бы в новое поле чужие числа.
        state.vfxComposite = {};
        context.refresh();
      },
    }),
  });
  if (state.vfxField !== '' && !(state.vfxField in image)) {
    rows.push(...fieldRows(context, name, state.vfxField, undefined, finding));
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
 * Строки одного поля записи. Составное поле формата (окно стата, порог цвета,
 * мигание, вертикальное смещение) раскрывается строками своих подполей —
 * вкладом `assetVfxComposite.ts`; прочие поля остаются одной строкой.
 */
function fieldRows(
  context: Context,
  name: string,
  field: string,
  current: JsonValue | undefined,
  finding: (subField: string) => ValidationState | undefined,
): readonly FieldRowSpec[] {
  const { state } = context;
  const spec = FIELD_SPECS.get(field);
  if (spec?.kind === 'composite') {
    return vfxCompositeRows({
      spec,
      value: isJsonObject(current) ? current : undefined,
      draft: state.vfxComposite,
      resources: context.resources,
      readOnly: context.mode === 'preview',
      finding: (subField) => finding(subField === '' ? field : `${field}.${subField}`),
      write: (next) => {
        writeField(context, name, field, next);
      },
      refresh: () => {
        context.refresh();
      },
    });
  }
  return [
    {
      label: documentValue(field),
      control: fieldControl(context, name, field, current, finding(field)),
    },
  ];
}

/**
 * Контрол одного поля записи: строковые поля пишутся текстом, прочие — числом.
 * Род поля называет описание формата (ASSET-6); поля, которого описание не
 * знает, панель показывает по тому, что в записи ЛЕЖИТ, — оно там законно быть
 * не обязано, а показать его автору она обязана.
 *
 * Пустая строка СНИМАЕТ поле (`null` операции): без снятия автор чистил бы
 * документ руками, чего ED-14 не допускает.
 */
function fieldControl(
  context: Context,
  name: string,
  field: string,
  current: JsonValue | undefined,
  validation: ValidationState | undefined,
): ReturnType<typeof textField> {
  const spec = FIELD_SPECS.get(field);
  const text = spec === undefined ? !composite(current) && typeof current !== 'number' : spec.kind === 'string';
  const shown = valueText(current);
  // Составное значение поля, которого описание не знает, видно, но не правится:
  // формы его панель не знает, и подменить объект строкой из этого поля значило
  // бы сломать запись жестом, который выглядит как правка числа.
  const locked = context.mode === 'preview' || (spec === undefined && composite(current));
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
    writeField(context, name, field, next);
  };
  return (text ? textField : numberField)({
    label: documentValue(field),
    value: documentValue(shown),
    readOnly: locked,
    ...(validation === undefined ? {} : { validation }),
    onCommit: commit,
  });
}

/**
 * Записать поле выбранного изображения либо снять его (`null`) — операцией и
 * только ей (ED-29). Удавшаяся запись закрывает черновик дописывания: поле уже
 * в документе, и строка «дописать» ему больше не нужна.
 */
function writeField(
  context: Context,
  name: string,
  field: string,
  value: JsonValue | null,
): void {
  const { state } = context;
  vfxOperation(context, VFX_OPERATIONS.setField, {
    table: state.vfxTable,
    name,
    index: state.vfxImage,
    field,
    value,
  });
  if (state.failure !== null || state.vfxField !== field) return;
  state.vfxField = '';
  state.vfxComposite = {};
  context.refresh();
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
