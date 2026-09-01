/**
 * @contribution Правило «ссылка манифеста визуалов не разрешается в файл дерева
 * контента» (ED-14) — вклад в реестр правил (ED-25), а не часть каркаса.
 *
 * ED-14 требует показывать автору три находки «до диска», и последствия у них
 * разные: неизвестный тип эффекта — предупреждение с пропуском записи
 * (`assets` ASSET-8), параметр вне диапазона — ошибка валидации манифеста, а
 * ссылка на отсутствующий ассет — заглушка с предупреждением (ASSET-4,
 * ASSET-6). Первые две проверяет владелец формата (`validateManifest`), третью
 * не проверял никто: существование файла видно только тому, у кого есть дерево.
 * Отсюда это правило и его важность — предупреждение, а не ошибка: редактор
 * последствия трёх находок не уравнивает.
 *
 * ## Дерево приходит индексом, а не чтением
 *
 * Правило исполняется синхронно и на каждую правку (ED-8), а перечисление
 * дерева — асинхронный шов хоста среды (ED-12). Поэтому пути файлов приносит
 * индекс, который живёт снаружи правила и обновляется тем, кто знает о правках
 * дерева, — тем же приёмом, каким живёт кэш источников конвейера Blender
 * (BLND-2). Правило спрашивает у индекса ТЕКУЩЕЕ состояние и не ждёт.
 *
 * Индекс, дерево которого ещё не перечислено, отвечает «не знаю», и правило
 * молчит. Это не послабление, а точность: «дерево не перечислено» и «файла нет»
 * — разные ответы (ASSET-14), и среда без перечисления (статическая веб-выкладка,
 * ED-12) выдала бы первый за второй, обвинив автора в опечатке, которой он не
 * делал.
 *
 * ## Чего здесь нет: знания о формате манифеста
 *
 * Где внутри документа лежат ID ассетов, знает манифест (`assets` ASSET-6), и
 * перечисляет их он же (`manifestAssetRefs`). Своей копии этого перечня правило
 * не заводит: она разошлась бы с форматом молча при первом же новом поле
 * (ED-1, CORE-3). Разбирает документ тот же `validateManifest`, что проверяет
 * его на загрузке; документ, который владелец отверг, ссылок не даёт вовсе —
 * о нём говорит правило формата, а не это.
 */
import { manifestAssetRefs, validateManifest } from '@fluxus/assets';
import type { DocumentKind } from '../document/index.js';
import { walkContentTree, type ContentTreeHost, type WalkOptions } from '../host/index.js';
import { ruleDescriptionKey } from './reasons.js';
import type { ValidationRule } from './types.js';

export const ASSET_REFERENCE_RULE = 'editor.assetReference';

/** Названного файла в дереве контента нет. */
const MISSING_ASSET = 'missingAsset';

/**
 * Что индекс знает о дереве контента прямо сейчас. Синхронная сторона — всё,
 * что нужно правилу; наполняет её тот, кто собирает редактор.
 */
export interface ContentIndex {
  /**
   * Перечислялось ли дерево хоть раз. `false` — правило молчит: о состоянии
   * редактора оно рассказывать не должно, а «не спрашивали» и «нет» — разные
   * ответы (ASSET-14).
   */
  readonly listed: boolean;
  /** Есть ли файл по этому пути от корня дерева (`assets` ASSET-2). */
  has(path: string): boolean;
}

/**
 * Индекс, дерево которого не перечислено, — умолчание правила. С ним правило
 * молчит, но существует: по набору правил считаются ключи строк его причин
 * (ED-28), и правило, у которого без индекса не было бы фабрики, выпало бы из
 * этого набора — то есть его причины числились бы осиротевшими.
 */
const UNLISTED: ContentIndex = Object.freeze({ listed: false, has: () => false });

export interface AssetReferenceOptions {
  /** Дерево контента; нет — правило молчит (см. `UNLISTED`). */
  readonly index?: ContentIndex;
  /** Вид документа манифеста визуалов; раскладку приносит собирающий (ED-25). */
  readonly manifest?: DocumentKind;
}

/**
 * ED-14: «ссылка на отсутствующий ассет… подсвечивается сразу в редакторе — до
 * диска». Проверяются все ссылки манифеста: модель записи, текстура слота
 * скина, эмиттерный документ обеих секций (ASSET-14) и карта кривизны арены
 * (ASSET-7).
 */
export function assetReferenceRule(options: AssetReferenceOptions = {}): ValidationRule {
  const index = options.index ?? UNLISTED;
  return {
    id: ASSET_REFERENCE_RULE,
    descriptionKey: ruleDescriptionKey(ASSET_REFERENCE_RULE),
    reasonCodes: [MISSING_ASSET],
    appliesTo: [options.manifest ?? 'manifest'],
    severity: 'warning',
    check(run) {
      if (!index.listed) return;
      const checked = validateManifest(run.document.value);
      if (!checked.ok) return;
      for (const ref of manifestAssetRefs(checked.manifest)) {
        if (index.has(ref.asset)) continue;
        run.report({
          path: [...ref.path],
          received: ref.asset,
          expected: { kind: 'presence', present: true },
          code: MISSING_ASSET,
          params: { asset: ref.asset },
        });
      }
    },
  };
}

/**
 * Наполняемая сторона индекса. Живёт у собирающего редактор (ED-25): он знает,
 * когда дерево изменилось, — открытие проекта и канал изменений хоста (ED-12),
 * тот же, которым едет hot-reload импорта (BLND-12).
 */
export interface ContentIndexCache extends ContentIndex {
  /** Перечислить дерево заново. Отказ среды гасит индекс, а не роняет прогон. */
  refresh(): Promise<void>;
  /** Забыть перечисленное: сменился корень, и прежние пути относились к нему. */
  forget(): void;
}

/**
 * Индекс путей файлов дерева контента поверх шва среды (ED-12). Обход —
 * общий (`walkContentTree`), а не свой: он одинаков в обеих средах, и второго
 * обхода в редакторе не заводится.
 *
 * Отказ перечисления гасит индекс целиком (`listed === false`), а не оставляет
 * половину дерева: половина сделала бы находки функцией того, до какого
 * каталога обход дошёл, — то есть обвинила бы автора в опечатке по причине,
 * лежащей в среде.
 */
export function createContentIndex(host: ContentTreeHost, options: WalkOptions = {}): ContentIndexCache {
  let files: ReadonlySet<string> | null = null;
  return {
    get listed(): boolean {
      return files !== null;
    },
    has(path) {
      return files?.has(path) ?? false;
    },
    forget() {
      files = null;
    },
    async refresh() {
      try {
        const entries = await walkContentTree(host, '', options);
        const found = new Set<string>();
        for (const entry of entries) if (entry.kind === 'file') found.add(entry.path);
        files = found;
      } catch {
        // Причина отказа принадлежит тому, кто умеет её показать: у правила
        // находки «среда не отдала дерево» нет, и выдумывать её здесь значило
        // бы говорить о состоянии редактора вместо состояния документов.
        files = null;
      }
    },
  };
}
