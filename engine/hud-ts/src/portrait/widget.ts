/**
 * Виджет живого портрета (HUD-7): DOM-виджет с собственной поверхностью
 * рендера внутри, на которой изолированный стенд рисует одну модель — модель
 * визуального типа доставленной сущности, найденную через манифест визуалов.
 * Стенд MUST NOT быть камерой в сцену арены — здесь это выполнено
 * конструктивно: THREE-часть сидит за швом `PortraitStage` (`stage.ts`),
 * которому не передаётся ничего, кроме общего asset-сервиса.
 *
 * ## Шов инъекции (`PortraitSetup`)
 *
 * По образцу контракта камеры у фасада действий (`actions.ts`,
 * `HudCameraContract`): узкая поверхность, которую сборка клиента реализует
 * поверх своих объектов. Сборка обязана передать ТОТ ЖЕ `AssetService`,
 * которым живёт рендер арены (ASSET-2): второго кэша над тем же деревом
 * MUST NOT существовать, и модель, уже загруженная ареной, приходит портрету
 * тем же handle из общего кэша — сценарий «Один кэш ассетов». Собственного
 * сервиса виджет не заводит нигде.
 *
 * Таблица «kind → запись манифеста» отдельно не инжектится: `kind`
 * доставленной сущности (`HudEntityView.kind`) — уже ключ манифеста визуалов
 * (SHELL-5), и разрешает его та же функция `resolveVisual`, что у подсистемы
 * моделей арены.
 *
 * ## Данные и реакции
 *
 * Сущность портрета приходит обычным биндингом (HUD-4): слот `hero` — чистый
 * селектор, возвращающий `HudEntityView` героя (или ничего, если его нет в
 * доставленном состоянии). Реакции — от доставленных событий (HUD-5), тем же
 * путём, что любая реакция HUD: событие смерти (`params.deathEvent`, по
 * умолчанию `EntityDied` — конвенция ядра, та же, что у `render-ts`)
 * переводит портрет в состояние `hud-portrait--dead`; событие урона (типы —
 * `params.damageEvents`) даёт краткую реакцию `hud-portrait--hit`, живущую
 * до следующей доставки без такого события, — CSS-класс, анимацию которого
 * задаёт стиль сборки. Признак разрыва (snap, HUD-5) снимает накопленные
 * состояния реакций.
 *
 * Из состояния `dead` портрет выводит СОБЫТИЕ возрождения (`params.reviveEvent`,
 * умолчания нет), а не только пересоздание сущности. Возрождение — политика
 * контента, и сцена вправе воскресить героя, НЕ трогая его `EntityId`: тогда
 * `spawned` не взводится (сущность не рождалась), доставка идёт без разрыва, и
 * без этого параметра портрет остался бы мёртвым на живом герое до конца матча.
 * Имени по умолчанию нет намеренно: конвенции ядра на «воскрес» не существует,
 * а угаданное имя молча не сработало бы (HUD-1: недостающее приходит данными).
 *
 * Известный пробел: события УРОНА в контенте сегодня нет (есть `EntityDied`,
 * `FellThroughFloor`, `CastFireball`, `FireballExploded`), поэтому
 * `damageEvents` по умолчанию пуст — виджет готов к событию, которое контент
 * заведёт данными (HUD-1: недостающее добавляется в доставляемую форму, а не
 * читается в обход).
 */
import {
  resolveVisual,
  type AssetService,
  type NormalizedModel,
  type VisualManifest,
} from '@game-mvp/assets';
import type { HudParams } from '../composition.js';
import type { HudDeliveredEvent, HudEntityView } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { toggleClass } from '../dom/render.js';
import type { HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';
import type { PortraitStage, PortraitStageFactory } from './stage.js';
import { createThreePortraitStage } from './threeStage.js';

/** Имя вида виджета в реестре (HUD-4). */
export const PORTRAIT_WIDGET_NAME = 'portrait';
/** Слот биндинга: селектор сущности портрета (`HudEntityView` героя). */
export const PORTRAIT_HERO_SLOT = 'hero';

/** Классы контейнера — контракт стилизации сборки. */
export const PORTRAIT_CLASS = 'hud-portrait';
/** Краткая реакция на доставленное событие урона (HUD-7). */
export const PORTRAIT_HIT_CLASS = 'hud-portrait--hit';
/** Состояние после доставленного события смерти (HUD-7). */
export const PORTRAIT_DEAD_CLASS = 'hud-portrait--dead';
/** Стенд пуст: героя нет в доставленном состоянии либо модель недоступна. */
export const PORTRAIT_EMPTY_CLASS = 'hud-portrait--empty';

/** Конвенция ядра — та же, что у `AnimationController` render-ts (REND-4). */
const DEFAULT_DEATH_EVENT = 'EntityDied';
/** Сторона квадратной поверхности стенда, px. */
const DEFAULT_SIZE_PX = 160;

/**
 * Шов инъекции виджета: что сборка клиента обязана передать при регистрации
 * вида. Всё это — общие объекты сборки, а не собственность виджета.
 */
export interface PortraitSetup {
  /**
   * РАЗДЕЛЯЕМЫЙ asset-сервис — тот самый инстанс, которым пользуется рендер
   * арены (ASSET-2). Виджет не конструирует ни сервиса, ни загрузчиков:
   * второй кэш над тем же деревом запрещён HUD-7.
   */
  readonly assets: AssetService;
  /** Манифест визуалов (ASSET-6) — тот же документ, что у подсистемы моделей. */
  readonly visuals: VisualManifest;
  /**
   * Фабрика стенда; по умолчанию — THREE-реализация (`threeStage.ts`).
   * Тесты подставляют заглушку — швом, а не мокая THREE.
   */
  readonly createStage?: PortraitStageFactory;
}

/** Число из параметров композиции с проверкой; иное — умолчание. */
function sizeOf(params: HudParams): number {
  const value = params.size;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SIZE_PX;
}

function deathEventOf(params: HudParams): string {
  const value = params.deathEvent;
  return typeof value === 'string' && value !== '' ? value : DEFAULT_DEATH_EVENT;
}

/**
 * Тип события возрождения из параметров композиции — данные, не код (HUD-4).
 * `null` — сборка такого события не завела: портрет выходит из `dead` только
 * пересозданием сущности или разрывом, как и раньше.
 */
function reviveEventOf(params: HudParams): string | null {
  const value = params.reviveEvent;
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Типы событий урона из параметров композиции — данные, не код (HUD-4). */
function damageEventsOf(params: HudParams): ReadonlySet<string> {
  const value = params.damageEvents;
  const names = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string') names.add(item);
  }
  return names;
}

/**
 * Значение слота `hero` — структурная проверка вместо доверия к композиции:
 * селектор подключается по имени, и чужой селектор в слоте не должен ронять
 * виджет — он даёт пустой стенд.
 */
function heroOf(value: unknown): HudEntityView | null {
  if (typeof value !== 'object' || value === null) return null;
  const view = value as Partial<HudEntityView>;
  return typeof view.id === 'number' ? (view as HudEntityView) : null;
}

class PortraitWidget implements HudWidget {
  private readonly setup: PortraitSetup;
  private readonly stage: PortraitStage;
  private readonly size: number;
  private readonly deathEvent: string;
  private readonly reviveEvent: string | null;
  private readonly damageEvents: ReadonlySet<string>;

  private container: Element | null = null;
  /** Последний известный id сущности портрета — по нему адресуются события. */
  private heroId: number | null = null;
  /** Визуальный тип, чья модель сейчас заказана стенду. */
  private kind: string | null = null;
  /** Отписка от состояния ассета текущей модели (ASSET-4). */
  private unsubscribe: (() => void) | null = null;
  private hit = false;
  private dead = false;
  private empty = true;
  private disposed = false;

  constructor(setup: PortraitSetup, params: HudParams) {
    this.setup = setup;
    this.size = sizeOf(params);
    this.deathEvent = deathEventOf(params);
    this.reviveEvent = reviveEventOf(params);
    this.damageEvents = damageEventsOf(params);
    // Стенд создаётся с ОДНИМ аргументом — общим asset-сервисом: не получив
    // ни сцены, ни камеры арены, рендерить её повторно он не может (HUD-7).
    this.stage = (setup.createStage ?? createThreePortraitStage)({ assets: setup.assets });
  }

  mount(): HudNode {
    const px = `${String(this.size)}px`;
    return el('div', {
      classes: [PORTRAIT_CLASS],
      // Портрет не интерактивен: указатель проходит к вьюпорту (HUD-3).
      style: { width: px, height: px, 'pointer-events': 'none' },
      ref: (element) => {
        this.container = element;
        this.applyClasses();
      },
      children: [
        el('canvas', {
          classes: [`${PORTRAIT_CLASS}-canvas`],
          // Атрибуты — размер буфера рендера; стиль — размер элемента.
          attrs: { width: String(this.size), height: String(this.size) },
          style: { width: '100%', height: '100%', display: 'block' },
          ref: (element) => {
            this.stage.attach(element as HTMLCanvasElement);
          },
        }),
      ],
    });
  }

  update(update: HudUpdate): void {
    if (this.disposed) return;
    const hero = heroOf(update.values[PORTRAIT_HERO_SLOT]);

    // Разрыв непрерывности (HUD-5): накопленные реакции снапаются к
    // доставленному состоянию, а не доигрываются через разрыв.
    if (update.snap) {
      this.setHit(false);
      this.setDead(false);
    }
    // Новая сущность в слоте или её респавн — прежняя смерть не про неё.
    if (hero !== null && (hero.id !== this.heroId || hero.spawned)) this.setDead(false);
    if (hero !== null) this.heroId = hero.id;

    // Модель — по визуальному типу доставленной сущности (HUD-7). Сущность,
    // ушедшая из доставленного состояния, тип не меняет: последняя модель
    // остаётся на стенде (смерть показывает событие, а не пустота кадра).
    if (hero !== null && hero.kind !== this.kind) {
      this.kind = hero.kind;
      this.swapModel(hero.kind);
    }

    // Реакции — от доставленных событий, как у любого виджета (HUD-4, HUD-5):
    // собственного канала к симуляции у стенда нет.
    let hitNow = false;
    for (const event of update.events) {
      if (!this.aboutHero(event)) continue;
      // Порядок доставки соблюдается: смерть и возрождение в ОДНОЙ доставке
      // (доставка идёт каденсом, а не потиково, HUD-5) читаются как есть —
      // последнее из двух и решает, чем портрет остался.
      if (event.type === this.deathEvent) this.setDead(true);
      else if (event.type === this.reviveEvent) this.setDead(false);
      else if (this.damageEvents.has(event.type)) hitNow = true;
    }
    this.setHit(hitNow);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stage.dispose();
  }

  /** Адресат события — сущность портрета: та же конвенция полей, что у render-ts. */
  private aboutHero(event: HudDeliveredEvent): boolean {
    if (this.heroId === null) return false;
    const target = event.data.entity ?? event.data.target ?? event.data.source;
    return target === this.heroId;
  }

  /**
   * Смена модели стенда: kind → запись манифеста (`resolveVisual` — тот же
   * резолвер, что у арены) → запрос модели у ОБЩЕГО сервиса (ASSET-2) →
   * `showModel` по готовности. Пока модель грузится или её нет — стенд пуст.
   */
  private swapModel(kind: string | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stage.clearModel();
    this.setEmpty(true);

    const visual = kind === null ? undefined : resolveVisual(this.setup.visuals, kind);
    if (visual === undefined) return;

    // Повторный запрос уже загруженного ареной ID возвращает тот же handle и
    // тот же разделяемый ассет из кэша — повторной загрузки нет (ASSET-2).
    const handle = this.setup.assets.request<NormalizedModel>('model', visual.model);
    this.unsubscribe = this.setup.assets.subscribe(handle, (state) => {
      if (state.status !== 'ready') return;
      this.stage.showModel(state.data, visual);
      this.setEmpty(false);
    });
  }

  private setHit(on: boolean): void {
    if (this.hit === on) return;
    this.hit = on;
    this.applyClasses();
  }

  private setDead(on: boolean): void {
    if (this.dead === on) return;
    this.dead = on;
    this.applyClasses();
  }

  private setEmpty(on: boolean): void {
    if (this.empty === on) return;
    this.empty = on;
    this.applyClasses();
  }

  /** Классы состояния — на материализованном контейнере (`ref` из mount). */
  private applyClasses(): void {
    const container = this.container;
    if (container === null) return;
    toggleClass(container, PORTRAIT_HIT_CLASS, this.hit);
    toggleClass(container, PORTRAIT_DEAD_CLASS, this.dead);
    toggleClass(container, PORTRAIT_EMPTY_CLASS, this.empty);
  }
}

/**
 * Вид виджета `portrait` для реестра (HUD-4). Ожидаемые слоты композиции:
 * биндинг `hero` — селектор сущности портрета; действий нет. Параметры:
 * `size` (px, сторона квадрата, по умолчанию 160), `deathEvent` (тип события
 * смерти, по умолчанию `EntityDied`), `reviveEvent` (тип события возрождения,
 * по умолчанию нет), `damageEvents` (типы событий урона, по умолчанию пусто —
 * см. шапку о пробеле в контенте).
 */
export function createPortraitKind(setup: PortraitSetup): HudWidgetKind {
  return {
    name: PORTRAIT_WIDGET_NAME,
    create: (params) => new PortraitWidget(setup, params),
  };
}
