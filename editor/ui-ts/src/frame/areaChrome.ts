/**
 * Обвязка рабочей области: то, что ED-24 требует одинаковым во всех областях, —
 * написанное однажды.
 *
 * Область отдаёт три узла в зоны одного скелета, правит документ только
 * зарегистрированной операцией (ED-29), показывает причину отказа структурно
 * (ED-30, ED-22) и просит перерисовать, когда её состояние изменилось. Всё это
 * — каркас, а не содержимое: содержимое у каждой области своё, и его здесь нет
 * ни одного имени (ED-25).
 *
 * Скопированное в каждую область, это расходилось бы по одному месту за раз:
 * область, забывшая погасить прежнюю причину на удачной операции, показывала бы
 * старый отказ поверх сделанной правки.
 */
import type { InspectorSubject } from '../inspector/index.js';
import { inspectorPanel } from '../inspector/index.js';
import { documentValue, el, resourceText, type UiNode } from '../dom/node.js';
import { statusChip } from '../widgets/chip.js';
import { withValidation } from '../widgets/validation.js';
import { reasonOf } from '../reason.js';
import type { AreaContext, AreaState, AreaZones } from './area.js';
import type { JsonValue, OperationParams, StringResources, ValidationReport } from '@fluxus/editor-core';

/**
 * Запись состояния, с которой обвязка умеет работать: причина последнего отказа
 * и просьба перерисовать. Больше каркас о состоянии области не знает — `AreaState`
 * пуст намеренно (ED-23).
 */
export interface AreaChromeState extends AreaState {
  /** Причина последнего отказа; `null` — отказа нет. */
  failure: string | null;
  /** Просьба перерисовать, которую область раздаёт своему асинхронному. */
  refresh: () => void;
}

/**
 * Правка идёт операцией и только ей (ED-29); отказ — структурный (ED-30), и его
 * причина показывается, а не теряется в обработчике нажатия.
 */
export function runOperation<S extends AreaChromeState>(
  context: AreaContext<S>,
  operationId: string,
  params: OperationParams,
): JsonValue | undefined {
  const { state, session } = context;
  try {
    const outcome = session.applyOperation(operationId, params);
    state.failure = null;
    return outcome.result;
  } catch (error) {
    state.failure = reasonOf(error);
    return undefined;
  } finally {
    context.refresh();
  }
}

/**
 * Просьба перерисовать нужна асинхронному: открытие документов и обход дерева
 * кончаются после того, как страница уже собрана (ED-12), и позвать её область
 * может только через каркас.
 */
export function keepRefresh<S extends AreaChromeState>(context: AreaContext<S>): void {
  context.state.refresh = () => {
    context.refresh();
  };
}

/**
 * Кадр области: просьба перерисовать плюс три узла в зоны одного скелета
 * (ED-24). Порядок и положение зон задаёт каркас, а не область, — поэтому и
 * собираются они здесь, а не тремя одинаковыми литералами по областям: область,
 * забывшая раздать просьбу перерисовать, молча не показывала бы результат
 * асинхронного открытия.
 *
 * Зоны приходят объектом, а не тремя аргументами подряд: у всех троих один тип,
 * и перепутанные местами они дали бы работающий, но неправильный кадр.
 */
export function areaFrame<S extends AreaChromeState>(
  context: AreaContext<S>,
  zones: {
    readonly navigator: (context: AreaContext<S>) => UiNode;
    readonly surface: (context: AreaContext<S>) => UiNode;
    readonly inspector: (context: AreaContext<S>) => UiNode;
  },
): AreaZones {
  keepRefresh(context);
  return {
    navigator: zones.navigator(context),
    surface: zones.surface(context),
    inspector: zones.inspector(context),
  };
}

/**
 * Инспектор области (ED-24): место и устройство у него одинаковы везде, и
 * различается только субъект. Реестр редакторов поля — от каркаса: вклад,
 * зарегистрированный один раз, подхватывается инспектором всех областей сразу
 * (ED-25). В превью правка недоступна и показана недоступной, а не молча не
 * принимающей ввод (ED-9, ED-26).
 */
export function areaInspector<S extends AreaChromeState>(
  context: AreaContext<S>,
  subject: InspectorSubject | null,
  /** Последний отчёт валидации (ED-8, ED-30): по нему поле и находит свою находку. */
  report?: ValidationReport | null,
): UiNode {
  const { state } = context;
  return inspectorPanel({
    resources: context.resources,
    session: context.session,
    fieldEditors: context.fieldEditors,
    subject,
    ...(report === undefined ? {} : { report }),
    disabled: context.mode === 'preview',
    onFailure: (reason) => {
      state.failure = reason;
      context.refresh();
    },
  });
}

/**
 * Строка «проект не открыт» (ED-12): пустой перечень на этом месте означал бы
 * «их нет», то есть неправду. Причина отказа, если она есть, вытесняет саму
 * подпись: автору важнее, почему не открылось, чем то, что не открыто.
 */
export function noProjectRow(
  resources: StringResources,
  labelKey: string,
  failure: string | null,
): UiNode {
  return el('div', {
    classes: ['fx-row'],
    children: [
      withValidation(
        statusChip({ label: resourceText(resources, labelKey), tone: 'warning' }),
        failure === null
          ? { severity: 'warning', reason: resourceText(resources, labelKey) }
          : { severity: 'error', reason: documentValue(failure) },
      ),
    ],
  });
}

/**
 * Строка «документ открыт без отслеживаемых списков»: адресовать записи нечем
 * (ED-29), и это отдельное утверждение, а не «записей нет».
 */
export function untrackedRow(resources: StringResources, labelKey: string): UiNode {
  return el('div', {
    classes: ['fx-row'],
    children: [
      withValidation(statusChip({ label: resourceText(resources, labelKey), tone: 'error' }), {
        severity: 'error',
        reason: resourceText(resources, labelKey),
      }),
    ],
  });
}
