/**
 * Отладочный источник инстансов моделей (`models.instances`, RDBG-1) —
 * объявляет его подсистема моделей в точке своей регистрации (REND-27).
 *
 * Показывает то, чего в кадре не видно по определению: объём-прокси инстанса в
 * ЕГО ВИДИМОЙ ПОЗЕ (REND-3, REND-15), признак отсечения по пирамиде (REND-21),
 * выбранный уровень детализации (REND-22) и ярус представления (REND-20).
 * Отсечённый инстанс рисуется другим цветом, а не пропускается: «его нет в
 * кадре» — это и есть ответ на вопрос «куда он делся».
 *
 * Запись перечня — это ОБЪЁМ-ПРОКСИ picking'а (`PickProxy`) плюс решения кадра,
 * и совпадение намеренное: показывается та же поза, которой инстанс нарисован, а
 * не второй её расчёт — тот разошёлся бы с картинкой ровно там, где разошёлся бы
 * picking (REND-15).
 */
import {
  DebugRows,
  type DebugColor,
  type DebugDraw,
  type DebugProbe,
  type DebugSource,
} from './contract.js';
import { createPickProxy, type PickProxy } from '../picking.js';

const VISIBLE_COLOR: DebugColor = 0x80c0ff;
const CULLED_COLOR: DebugColor = 0x806060;
const DECORATION_COLOR: DebugColor = 0xc0a0ff;
/** Потолок перечня инстансов (RDBG-7); величина потолка — политика источника. */
const INSTANCE_CAP = 128;

/** Один инстанс глазами отладки: объём-прокси плюс решения этого кадра. */
export interface DebugInstanceRow extends PickProxy {
  /** Ярус, которым инстанс нарисован (REND-20). */
  tier: string;
  /** Выбранный уровень детализации (REND-22); 0 — модель как она есть. */
  lodLevel: number;
  /** Инстанс попал в пирамиду видимости этого кадра (REND-21). */
  visible: boolean;
  /** В кадре стоит заглушка (`assets` ASSET-4), а не модель. */
  placeholder: boolean;
}

export interface DebugModelsProbe extends DebugProbe {
  /** Инстансов presentation-состояния и декораций (REND-3, REND-18). */
  readonly instanceCount: number;
  readonly decorationCount: number;
  /** Инстансов ВНЕ пирамиды видимости этого кадра (REND-21). */
  readonly culledCount: number;
  readonly placeholderCount: number;
  /** Инстансов по ярусам представления (REND-20): имя яруса → сколько. */
  readonly byTier: Readonly<Record<string, number>>;
  /** Инстансов по выбранному уровню детализации (REND-22): индекс — уровень. */
  readonly byLodLevel: readonly number[];
}

/** Что источнику нужно от подсистемы моделей — обход её нарисованного. */
export interface ModelsDebugAccess {
  /**
   * Обход инстансов обоих пулов в порядке набора (REND-18: сперва сущности,
   * затем декорации). Подсистема заполняет ОДНУ переданную запись и зовёт
   * `visit` — свежей записи на инстанс не появляется (RDBG-2, REND-26).
   */
  each(out: DebugInstanceRow, visit: () => void): void;
}

export function modelsInstancesDebugSource(
  access: ModelsDebugAccess,
): DebugSource<DebugModelsProbe> {
  const rows = new DebugRows<DebugInstanceRow>(INSTANCE_CAP, emptyRow);
  const byTier: Record<string, number> = {};
  const byLodLevel: number[] = [];
  const probe = {
    instanceCount: 0,
    decorationCount: 0,
    culledCount: 0,
    placeholderCount: 0,
    byTier,
    byLodLevel,
    instances: rows.list,
    noData: undefined as string | undefined,
  };
  /** Запись обхода: одна на источник, переиспользуемая между кадрами (RDBG-2). */
  const scratch = emptyRow();

  return {
    id: 'models.instances',
    title: 'инстансы моделей: объём, отсечение, уровень детализации',
    probe(): DebugModelsProbe {
      probe.noData = undefined;
      let instances = 0;
      let decorations = 0;
      let culled = 0;
      let placeholders = 0;
      for (const key of Object.keys(byTier)) byTier[key] = 0;
      byLodLevel.length = 0;
      rows.begin();
      access.each(scratch, () => {
        // Агрегаты считаются по ВСЕМ инстансам, перечень — под потолком: иначе
        // «сколько отсечено» отвечало бы про первые сто двадцать восемь.
        if (scratch.decoration) decorations += 1;
        else instances += 1;
        if (!scratch.visible) culled += 1;
        if (scratch.placeholder) placeholders += 1;
        byTier[scratch.tier] = (byTier[scratch.tier] ?? 0) + 1;
        byLodLevel[scratch.lodLevel] = (byLodLevel[scratch.lodLevel] ?? 0) + 1;
        const row = rows.next();
        if (row !== null) Object.assign(row, scratch);
      });
      rows.end();
      for (let i = 0; i < byLodLevel.length; i += 1) byLodLevel[i] ??= 0;
      probe.instanceCount = instances;
      probe.decorationCount = decorations;
      probe.culledCount = culled;
      probe.placeholderCount = placeholders;
      return probe;
    },
    draw(value: DebugModelsProbe, out: DebugDraw): void {
      const list = value.instances as { items: readonly DebugInstanceRow[] };
      for (const row of list.items) {
        const color = !row.visible
          ? CULLED_COLOR
          : row.decoration
            ? DECORATION_COLOR
            : VISIBLE_COLOR;
        out.box(row, color);
      }
    },
  };
}

/** Пустая запись: объём-прокси общей фабрикой плюс поля решений кадра. */
function emptyRow(): DebugInstanceRow {
  return { ...createPickProxy(), tier: '', lodLevel: 0, visible: true, placeholder: false };
}
