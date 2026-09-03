/**
 * @contribution Черновик секций VFX манифеста (ED-14): чем автор заводит новый
 * источник — изображение эффекта (REND-23) либо привязку эмиттера (ASSET-14).
 *
 * Отдельным модулем от таблиц (`assetVfxRows.ts`) по размеру, а не по смыслу:
 * «что уже есть в документе» и «что автор набирает, чтобы завести новое» — два
 * блока строк над одной записью состояния, и держать их в одном файле значило
 * бы получить модуль, который метрика размера велит делить (ED-25).
 *
 * Перечня примитивов здесь нет и здесь: имя примитива автор набирает, а годность
 * его называет рендер предупреждением (REND-23), негодную же запись — владелец
 * формата отказом операции (ASSET-6).
 */
import { documentValue, resourceText } from '../dom/node.js';
import { button } from '../widgets/button.js';
import { select, textField } from '../widgets/field.js';
import type { FieldRowSpec } from '../widgets/fieldTable.js';
import { VFX_OPERATIONS } from './assetVfx.js';
import {
  TABLE_LABEL_KEYS,
  VFX_TABLES,
  vfxOperation,
  type VfxContext,
} from './assetVfxRows.js';

/** Число черновика параметром операции; пустое либо негодное — параметра нет. */
function number(raw: string, name: string): Record<string, number> {
  const parsed = Number(raw);
  return raw.trim() === '' || Number.isNaN(parsed) ? {} : { [name]: parsed };
}

/**
 * Заведение источника В МАНИФЕСТЕ ВИЗУАЛОВ (ASSET-6): таблица, имя и то
 * немногое, без чего запись не бывает
 * валидной (REND-23 — примитив и цвет; радиус либо ширина, смотря по примитиву).
 * Какое из двух чисел обязательно ЭТОМУ примитиву, отвечает владелец формата, и
 * его отказ автор увидит целиком — своего перечня примитивов панель не знает.
 */
export function vfxManifestDraftRows(context: VfxContext): readonly FieldRowSpec[] {
  const { state, resources, session } = context;
  const off = context.mode === 'preview';
  const ready = state.visualsId !== null && session.isOpen(state.visualsId) && !off;
  const draft = (
    key: string,
    field: 'vfxName' | 'vfxPrimitive' | 'vfxColor' | 'vfxRadius' | 'vfxWidth' | 'vfxAsset',
  ): FieldRowSpec => ({
    label: resourceText(resources, key),
    control: textField({
      label: resourceText(resources, key),
      value: documentValue(state[field]),
      readOnly: off,
      onCommit: (raw) => {
        state[field] = raw.trim();
        context.refresh();
      },
    }),
  });
  return [
    {
      label: resourceText(resources, 'ui.area.assets.vfxTable'),
      control: select({
        label: resourceText(resources, 'ui.area.assets.vfxTable'),
        value: state.vfxTable,
        options: VFX_TABLES.map((table) => ({
          value: table,
          label: resourceText(resources, TABLE_LABEL_KEYS[table] ?? 'ui.area.assets.none'),
        })),
        onSelect: (next) => {
          state.vfxTable = next;
          state.vfxSource = '';
          state.vfxImage = 0;
          context.refresh();
        },
      }),
    },
    draft('ui.area.assets.vfxSource', 'vfxName'),
    draft('ui.area.assets.vfxPrimitive', 'vfxPrimitive'),
    draft('ui.area.assets.vfxColor', 'vfxColor'),
    draft('ui.area.assets.vfxRadius', 'vfxRadius'),
    draft('ui.area.assets.vfxWidth', 'vfxWidth'),
    {
      label: resourceText(resources, 'ui.area.assets.vfxAddImage'),
      control: button({
        label: resourceText(resources, 'ui.area.assets.vfxAddImage'),
        variant: 'ghost',
        disabled: !ready || state.vfxName === '' || state.vfxPrimitive === '',
        onPress: () => {
          vfxOperation(context, VFX_OPERATIONS.addImage, {
            table: state.vfxTable,
            name: state.vfxName,
            primitive: state.vfxPrimitive,
            color: state.vfxColor,
            // Оба числа необязательны, и панель отдаёт то, что автор назвал:
            // какое из них требуется примитиву, знает владелец формата.
            ...number(state.vfxRadius, 'radius'),
            ...number(state.vfxWidth, 'width'),
          });
          state.vfxSource = state.vfxName;
        },
      }),
    },
    draft('ui.area.assets.vfxEffectAsset', 'vfxAsset'),
    {
      label: resourceText(resources, 'ui.area.assets.vfxBindEmitter'),
      control: button({
        label: resourceText(resources, 'ui.area.assets.vfxBindEmitter'),
        variant: 'ghost',
        disabled: !ready || state.vfxName === '' || state.vfxAsset === '',
        onPress: () => {
          vfxOperation(context, VFX_OPERATIONS.setEmitter, {
            table: state.vfxTable,
            name: state.vfxName,
            asset: state.vfxAsset,
          });
        },
      }),
    },
  ];
}
