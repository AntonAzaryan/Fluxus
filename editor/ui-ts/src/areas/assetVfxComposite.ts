/**
 * @contribution Строки СОСТАВНОГО поля записи эффекта (ED-14): окна
 * доставленного стата, порога цвета, мигания и вертикального смещения
 * (`assets` ASSET-6, `rendering` REND-23, REND-12). Вклад в область
 * просмотрщика (ED-25), а не часть каркаса.
 *
 * ## Отдельным модулем и без ссылки на панель
 *
 * Составное поле — самостоятельный блок: у него свои подполя, своё заведение и
 * своё снятие, а модуль строк панели (`assetVfxRows.ts`) уже у метрики размера.
 * Ссылки на панель здесь нет вовсе — ни на её состояние, ни на её операции:
 * модуль получает ОПИСАНИЕ поля (ASSET-6), значение, черновик и замыкания
 * «записать», «находка», «перерисовать». Иначе вышел бы цикл модулей, который
 * архитектурное правило репозитория запрещает, — и заодно второе место,
 * знающее, где в манифесте лежит секция.
 *
 * ## Перечня подполей здесь нет
 *
 * Он приезжает описанием владельца формата ({@link ManifestFieldSpec}) — то же
 * основание, по которому у панели нет своего перечня полей записи (ED-14). Род
 * подполя выбирает контрол строки: строка правится текстом, число — числовым
 * полем, а годность значения называет владелец отказом операции (ED-30).
 *
 * ## Поле пишется ЦЕЛИКОМ
 *
 * Операция правки принимает значение поля целиком (`assetVfx.ts`), и каждая
 * строка отдаёт ей весь объект: у составного поля есть ОБЯЗАТЕЛЬНЫЕ подполя
 * (окно без конца — деление на ноль у потребителя), и запись одного подполя
 * оставила бы в документе заведомо невалидное значение. По той же причине
 * ЗАВОДИМОЕ поле собирается черновиком (ED-23): подполя набираются по одному, а
 * в документ уходят разом, и собранное проверяет владелец.
 */
import type { JsonValue, TextSource } from '@fluxus/editor-core';
import type { ManifestFieldSpec } from '@fluxus/assets';
import { documentValue, el, resourceText } from '../dom/node.js';
import { button } from '../widgets/button.js';
import { numberField, textField } from '../widgets/field.js';
import type { FieldRowSpec } from '../widgets/fieldTable.js';
import { withValidation, type ValidationState } from '../widgets/validation.js';

/** Подписи двух действий над полем целиком. */
const WRITE_KEY = 'ui.area.assets.vfxSetField';
const REMOVE_KEY = 'ui.area.assets.vfxRemoveField';

/** Оболочка контрола строки — та же, в которой живут поля ввода. */
const CONTROL_CLASS = 'fx-control';

export interface CompositeRowsOptions {
  /** Описание составного поля — его состав (ASSET-6). */
  readonly spec: ManifestFieldSpec;
  /**
   * Значение поля в записи; `undefined` — поля в записи нет ЛИБО лежит значение
   * не той формы (число вместо объекта). Обе беды лечатся одинаково — записью
   * годного значения, — и разводить их двумя видами строк незачем.
   */
  readonly value: Readonly<Record<string, JsonValue>> | undefined;
  /**
   * Черновик заводимого поля (ED-23): тексты подполей, как их набрал автор.
   * Ключ — `поле.подполе`, потому что у разных составных полей подполя
   * называются одинаково (`alpha` есть и у мигания, и у порога был бы тем же
   * словом).
   */
  readonly draft: Record<string, string>;
  readonly resources: TextSource;
  readonly readOnly: boolean;
  /**
   * Находка владельца, адресованная подполю (ED-8); пустое имя — само поле,
   * `undefined` — находок нет.
   */
  readonly finding: (subField: string) => ValidationState | undefined;
  /** Записать поле целиком либо снять его (`null`) — операцией и только ей (ED-29). */
  readonly write: (value: JsonValue | null) => void;
  /** Перерисовать: черновик живёт в записи области, а не в DOM. */
  readonly refresh: () => void;
}

/**
 * Строки одного составного поля: действие над полем целиком и по строке на
 * подполе. Есть значение — подполя правятся в документе, нет — набираются в
 * черновик и уходят одной записью.
 */
export function vfxCompositeRows(options: CompositeRowsOptions): readonly FieldRowSpec[] {
  const rows: FieldRowSpec[] = [actionRow(options)];
  for (const sub of options.spec.fields ?? []) rows.push(subRow(options, sub));
  return rows;
}

/** Действие над полем целиком: завести набранное либо снять имеющееся. */
function actionRow(options: CompositeRowsOptions): FieldRowSpec {
  const { spec, value, draft, resources, readOnly, finding, write } = options;
  const label = resourceText(resources, value === undefined ? WRITE_KEY : REMOVE_KEY);
  const written = value === undefined ? fromDraft(spec, draft) : null;
  const control = button({
    label,
    variant: 'ghost',
    // Пустой черновик записывать нечего, и действие показано недоступным
    // (ED-26), а не срабатывает вхолостую: поле из одних умолчаний — шум в
    // документе (ED-21), а не решение автора.
    disabled: readOnly || (written !== null && Object.keys(written).length === 0),
    onPress: () => {
      write(written);
    },
  });
  // Находка, адресованная полю ЦЕЛИКОМ (порог цвета без окна, значение не той
  // формы), встаёт у этой строки — рядом с действием над полем. Кнопка ради
  // этого лежит в той же оболочке контрола, что и поля ввода: знак находки
  // обязан стоять рядом с контролом, а не внутри подписи кнопки.
  return {
    label: documentValue(spec.name),
    control: withValidation(el('div', { classes: [CONTROL_CLASS], children: [control] }), finding('')),
  };
}

/**
 * Строка подполя. У имеющегося значения правка уходит в документ сразу — полем
 * целиком; у заводимого копится в черновике до нажатия «записать».
 *
 * Пустая строка СНИМАЕТ подполе, а не пишет пустое значение: обязательное
 * подполе после этого назовёт владелец находкой, и это честнее, чем ноль,
 * подставленный панелью.
 */
function subRow(options: CompositeRowsOptions, sub: ManifestFieldSpec): FieldRowSpec {
  const { spec, value, draft, readOnly, finding, write, refresh } = options;
  const key = `${spec.name}.${sub.name}`;
  const shown = value === undefined ? (draft[key] ?? '') : valueText(value[sub.name]);
  const validation = finding(sub.name);
  const label = documentValue(key);
  // Вложенного составного значения формат сегодня не знает; попадись оно —
  // подполей у него панель не выведет и правкой текста ломать его не станет.
  const control = sub.kind === 'number' ? numberField : textField;
  return {
    label,
    control: control({
      label,
      value: documentValue(shown),
      readOnly: readOnly || sub.kind === 'composite',
      ...(validation === undefined ? {} : { validation }),
      onCommit: (raw) => {
        const trimmed = raw.trim();
        if (trimmed === shown) return;
        if (value === undefined) {
          draft[key] = trimmed;
          refresh();
          return;
        }
        write(withSub(value, sub, parse(sub, trimmed)));
      },
    }),
  };
}

/** Значение подполя строкой: составное показывается своим JSON. */
function valueText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Набранный текст значением подполя; `undefined` — подполя в записи не будет. */
function parse(sub: ManifestFieldSpec, raw: string): JsonValue | undefined {
  if (raw === '') return undefined;
  if (sub.kind !== 'number') return raw;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Значение поля с правленым подполем. Порядок ключей сохраняется: правка одного
 * числа не должна перекладывать соседей в диффе документа (ED-21).
 */
function withSub(
  value: Readonly<Record<string, JsonValue>>,
  sub: ManifestFieldSpec,
  next: JsonValue | undefined,
): Record<string, JsonValue> {
  const written: Record<string, JsonValue> = {};
  let seen = false;
  for (const [key, current] of Object.entries(value)) {
    if (key !== sub.name) {
      written[key] = current;
      continue;
    }
    seen = true;
    if (next !== undefined) written[key] = next;
  }
  if (!seen && next !== undefined) written[sub.name] = next;
  return written;
}

/** Черновик значением поля: набранные подполя в порядке описания, пустые — мимо. */
function fromDraft(
  spec: ManifestFieldSpec,
  draft: Readonly<Record<string, string>>,
): Record<string, JsonValue> {
  const written: Record<string, JsonValue> = {};
  for (const sub of spec.fields ?? []) {
    const value = parse(sub, (draft[`${spec.name}.${sub.name}`] ?? '').trim());
    if (value !== undefined) written[sub.name] = value;
  }
  return written;
}
