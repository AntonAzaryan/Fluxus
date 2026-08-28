/**
 * Эмиттерный ассет (ASSET-14): JSON-документ эффекта частиц в дереве контента,
 * адресуемый как любой ассет (ASSET-2) и загружаемый через реестр загрузчиков
 * по формату (ASSET-3). Документ пишет внешний редактор эффектов (quarks.art),
 * а не код: новый эффект — ассет плюс запись манифеста (`rendering` REND-24).
 *
 * ## Форма проверяется у корня, а не целиком
 *
 * Диалект документа — сериализация графа объектов three.js, которой владеет
 * библиотека частиц рендера; её версия фиксируется зависимостью `render-ts`.
 * Модуль ассетов рендер-агностичен (ASSET-5) и на эту библиотеку не ссылается:
 * он проверяет ФОРМУ КОРНЯ — что это документ графа объектов и что в нём есть
 * хотя бы один эмиттер, — и отдаёт документ как есть.
 *
 * Полной схемы здесь нет намеренно: набор генераторов, поведений и настроек
 * рендеринга внутри эффекта принадлежит библиотеке и богаче любого перечня,
 * который мы бы здесь завели, — документ, написанный более новой версией
 * редактора, обязан оставаться легальным (то же основание, что у неизвестного
 * примитива эффекта REND-23 и неизвестного типа эффекта камеры ASSET-8).
 * Отказ — только на не-документе; всё остальное разбирает рендер и на битой
 * начинке предупреждает и пропускает эффект (REND-24), а не роняет кадр.
 *
 * Правка эффекта не меняет `worldInit`, снапшоты и golden-файлы: ассет живёт в
 * модуле presentation-ассетов и в симуляцию не ходит (ASSET-1).
 */

import { isRecord, typeName } from './validation.js';

/**
 * Узел графа объектов документа: эмиттер, группа над эмиттерами либо любой
 * другой узел three.js. Названы только те поля, по которым модуль судит о форме;
 * остальное — зона библиотеки и проходит нетронутым.
 */
export interface ParticleEffectNode {
  /** Тип узла (`ParticleEmitter`, `Group`, …) — им документ и опознаётся. */
  readonly type: string;
  readonly children?: readonly ParticleEffectNode[];
  readonly [field: string]: unknown;
}

/** Документ эффекта целиком: корневой узел плюс словари ресурсов документа. */
export interface ParticleEffectDocument {
  readonly object: ParticleEffectNode;
  readonly [field: string]: unknown;
}

/**
 * Тип узла-эмиттера в графе объектов. Единственное имя из словаря библиотеки,
 * которое модулю ассетов знать приходится: без него «документ эффекта» не
 * отличить от произвольной сцены three.js, а отличать их — работа валидации.
 */
const EMITTER_NODE_TYPE = 'ParticleEmitter';

/** Диалект документа — граф объектов three.js; иные метаданные не наши. */
const OBJECT_GRAPH_METADATA_TYPE = 'Object';

/**
 * Узел графа и его потомки. Проверяется ровно форма узла — запись с непустым
 * строковым типом и, если он есть, списком потомков; поля самого узла (матрица,
 * материалы, описание системы частиц) валидации не подлежат по причине из
 * заголовка модуля. Возвращает `true`, если в поддереве нашёлся эмиттер.
 */
function validateNode(node: unknown, path: string, errors: string[]): boolean {
  if (!isRecord(node)) {
    errors.push(`${path}: ожидался узел графа объектов, получено ${typeName(node)}`);
    return false;
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    errors.push(`${path}.type: обязательное поле — тип узла (непустая строка), получено ${typeName(node.type)}`);
  }
  let hasEmitter = node.type === EMITTER_NODE_TYPE;
  if ('children' in node) {
    if (!Array.isArray(node.children)) {
      errors.push(`${path}.children: ожидался список узлов графа, получено ${typeName(node.children)}`);
    } else {
      node.children.forEach((child, index) => {
        if (validateNode(child, `${path}.children[${index}]`, errors)) hasEmitter = true;
      });
    }
  }
  return hasEmitter;
}

/**
 * Валидация документа эффекта (ASSET-14). Ошибки собираются все разом и каждая
 * несёт путь до узла — правка документа не должна превращаться в угадывание,
 * хотя писать его руками никто и не обязан.
 */
export function validateParticleEffect(
  doc: unknown,
): { ok: true; effect: ParticleEffectDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(doc)) {
    return {
      ok: false,
      errors: [`эмиттерный ассет: ожидался объект-документ эффекта, получено ${typeName(doc)}`],
    };
  }
  // Метаданные необязательны, но если документ называет свой диалект — он
  // обязан быть графом объектов: JSON геометрии или анимации, попавший сюда по
  // ошибке, отвергается по своей же метке, а не по отсутствию эмиттера.
  if ('metadata' in doc) {
    if (!isRecord(doc.metadata)) {
      errors.push(`metadata: ожидался объект метаданных документа, получено ${typeName(doc.metadata)}`);
    } else if (
      'type' in doc.metadata &&
      doc.metadata.type !== OBJECT_GRAPH_METADATA_TYPE
    ) {
      errors.push(
        `metadata.type: документ эффекта — граф объектов ("${OBJECT_GRAPH_METADATA_TYPE}"), получено ${JSON.stringify(doc.metadata.type)}`,
      );
    }
  }
  if (!('object' in doc)) {
    errors.push('object: обязательное поле — корневой узел графа объектов эффекта');
    return { ok: false, errors };
  }
  const hasEmitter = validateNode(doc.object, 'object', errors);
  if (!hasEmitter && errors.length === 0) {
    errors.push(
      `object: в документе нет ни одного эмиттера (узла type "${EMITTER_NODE_TYPE}") — это не документ эффекта`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  // Документ отдаётся как есть: тип его полей readonly, а глубокая заморозка
  // стоила бы обхода всего документа ради того, что и так никто не правит, —
  // остальные presentation-ассеты модуля живут по этому же правилу (ASSET-5).
  return { ok: true, effect: doc as unknown as ParticleEffectDocument };
}
