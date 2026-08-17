/**
 * HUD демо на пакете `@game-mvp/hud` (задача 5.2): композиция — декларативное
 * TS-значение (HUD-4), реестры видов/селекторов/действий — сборка демо,
 * исполнитель и оверлей-хост — из пакета. Ad-hoc HUD из `main.ts` заменён
 * целиком: статус матча, панель способностей, миникарта и живой портрет —
 * обычные виджеты за единым интерфейсом.
 *
 * Действия HUD (HUD-2): мировые (`cast`/`dodge`/`jump`) идут через фасад —
 * обычный источник ввода в ТОМ ЖЕ сэмплере, что клавиатура (`main.ts` добавляет
 * `facade` в `InputSampler`), поэтому «кнопка неотличима от клавиши»; команды
 * паузы — обратным каналом `RemoteHost.control`; клик миникарты — presentation-
 * действие контракта камеры, сообщений воркеру не порождает.
 */
import type { AssetService, VisualManifest } from '@game-mvp/assets';
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  cooldownsKind,
  createPortraitKind,
  deathsKind,
  hpBarKind,
  matchStatusKind,
  minimapEntitiesSelector,
  minimapFloorSelector,
  minimapWidgetKind,
  runtimeKind,
  type HudCameraContract,
  type HudComposition,
  type HudControlChannel,
  type HudDeliveredState,
  type HudEntityView,
  type HudIconSource,
  type MinimapFogSource,
  type MinimapTerrainSource,
} from '@game-mvp/hud';
import { COOLDOWN_ABILITIES, RESPAWN_EVENT, STATS } from './sim.js';

/** Что даёт оболочка этой сборки: от этого зависит состав HUD (SHELL-8). */
export interface DemoShellCapabilities {
  /**
   * Есть ли у оболочки машина состояний мира: пауза и перемотка. У локальной
   * (`WorkerShell`) есть, у тонкого сетевого клиента нет и быть не может
   * (`netcode` NET-11, `snapshot-rewind` REW-6) — там эти кнопки не прячутся
   * стилем, а не появляются вовсе (design D5).
   */
  readonly controls: boolean;
  /**
   * Длительность тика в миллисекундах — из handshake (SHELL-5). Оверлей
   * кулдауна переводит по ней доставленные ТИКИ в секунды (HUD-8): сам он не
   * тикает и своих часов не заводит.
   */
  readonly tickMs: number;
}

/** Иконки способностей демо — asset ID дерева контента (ASSET-2), не URL. */
const ABILITY_ICONS: Readonly<Record<string, string>> = {
  cast: 'visuals/icons/cast.svg',
  dodge: 'visuals/icons/dodge.svg',
  jump: 'visuals/icons/jump.svg',
  slowDome: 'visuals/icons/slow-dome.svg',
  capture: 'visuals/icons/capture.svg',
  shield: 'visuals/icons/shield.svg',
  rewind: 'visuals/icons/rewind.svg',
};

/**
 * Композиция HUD демо — значение, а не код (HUD-4): виджеты по зонам, все
 * ссылки — имена реестров. Таблица маркеров миникарты покрывает ВСЕ визуальные
 * типы демо-сцены (`extractor.ts`, `kindByTags(['Hero', 'Fireball',
 * 'SlowDome'])`); тип без записи получает default-маркер по политике таблицы, а
 * не ошибку (HUD-6) — но безымянный серый квадрат на месте способности читается
 * как «что-то сломалось», поэтому у купола запись своя.
 * Иконки способностей — asset ID дерева контента (ASSET-2), не URL.
 *
 * Функция от возможностей оболочки, а не константа: сборок у демо две, и
 * различие между ними — деградация ровно одного виджета. Остальные (миникарта,
 * портрет, панель способностей) работают от той же доставки SHELL-2..5, и им
 * всё равно, кто тикает.
 */
export function demoHudComposition(capabilities: DemoShellCapabilities): HudComposition {
  return {
    entries: [
      {
        widget: 'match-status',
        zone: 'top-left',
        params: { controls: capabilities.controls },
        // Слоты действий ведут в реестр только там, где им есть куда вести:
        // запрос паузы от тонкого клиента не исполнил бы никто (SHELL-6).
        ...(capabilities.controls
          ? { actions: { pause: 'match.pause', resume: 'match.resume' } }
          : {}),
      },
      // Рантайм-панель (design D5): кадры главного потока, тик доставки и число
      // доставленных сущностей. Помощь по управлению уехала в README демо —
      // статический блок поверх вьюпорта на её месте больше не висит.
      {
        widget: 'runtime',
        zone: 'top-left',
        bindings: { entities: 'entities' },
      },
      // Счётчики смертей по слотам игроков (HUD-8): пока геймплейная система
      // счёт не ведёт, строки показывают прочерк — «нет данных», а не 0.
      {
        widget: 'deaths',
        zone: 'top',
        params: { slotStat: STATS.slot, deathsStat: STATS.deaths },
        bindings: { entities: 'entities' },
      },
      {
        widget: 'cooldowns',
        zone: 'bottom',
        params: {
          // Имена семантических действий словаря биндингов демо (INP-4, sim.ts)
          // плюс имена статов кулдауна — биндинг виджета на доставку (HUD-8).
          abilities: COOLDOWN_ABILITIES.map((ability) => ({
            action: ability,
            icon: ABILITY_ICONS[ability] ?? '',
            stat: STATS.cooldown(ability),
            maxStat: STATS.cooldownMax(ability),
          })),
          // Два ряда снизу по центру (design D5).
          perRow: 2,
          tickMs: capabilities.tickMs,
        },
        bindings: { entity: 'hero.entity' },
        actions: {
          cast: 'hero.cast',
          dodge: 'hero.dodge',
          jump: 'hero.jump',
          slowDome: 'hero.slowDome',
          capture: 'hero.capture',
          shield: 'hero.shield',
          rewind: 'hero.rewind',
        },
      },
      {
        // Миникарта — слева, под рантайм-панелью (design D5).
        widget: 'minimap',
        zone: 'left',
        params: {
          width: 180,
          height: 180,
          markers: {
            markers: {
              Hero: {
                renderer: 'dot',
                color: { mode: 'fixed', color: '#ffd479' },
                size: 9,
                priority: 10,
              },
              Fireball: {
                renderer: 'triangle',
                color: { mode: 'fixed', color: '#ff7a45' },
                size: 7,
                priority: 5,
              },
              // Купол — зона, а не цель: крупная тусклая точка того же голубого,
              // что оболочка эффекта в манифесте, и НИЖЕ всех по приоритету —
              // герой внутри купола перекрывает его, а не наоборот.
              SlowDome: {
                renderer: 'dot',
                color: { mode: 'fixed', color: '#6fd3ff' },
                size: 11,
                priority: 1,
              },
            },
            unknownKind: {
              policy: 'default',
              marker: {
                renderer: 'square',
                color: { mode: 'fixed', color: '#9aa3b2' },
                size: 5,
                priority: 0,
              },
            },
          },
        },
        bindings: { entities: 'minimap.entities', floor: 'minimap.floor' },
        actions: { pan: 'camera.pan' },
      },
      {
        // Портрет −15% от прежних 144 px: размер — параметр композиции, а не
        // константа виджета (design D5).
        widget: 'portrait',
        zone: 'bottom-left',
        // `reviveEvent` — событие сцены (`Respawn`, order 140): смерть в этой
        // сцене не терминальна, а возрождение НЕ пересоздаёт сущность — тот же
        // `EntityId` снимает `Dead` и получает полное здоровье. Без имени
        // события портрет остался бы мёртвым на живом герое: `spawned` не
        // взводится, разрыва в доставке нет (HUD-5). Имя — одно на сборку
        // (`RESPAWN_EVENT`): им же рендер снимает фиксацию клипа смерти (REND-4).
        params: { size: 122, reviveEvent: RESPAWN_EVENT },
        bindings: { hero: 'hero.entity' },
      },
      {
        // Полоса здоровья под портретом — та же зона, следующая запись.
        widget: 'hp-bar',
        zone: 'bottom-left',
        params: { stat: STATS.hp, maxStat: STATS.hpMax },
        bindings: { entity: 'hero.entity' },
      },
    ],
  };
}

/**
 * Резолв иконок: asset ID → URL тем же корнем дерева контента, каким
 * `AssetSource` демо кормит рендер (`main.ts`: `fetch('/<id>')` — vite отдаёт
 * `content/` как статику). Второго способа адресовать контент не появляется
 * (HUD-4, ASSET-2).
 */
const iconSource: HudIconSource = {
  resolveIconUrl: (assetId) => `/${assetId}`,
};

/**
 * Селектор сущности героя — чистая функция над доставленным состоянием
 * (HUD-4): герой демо-сцены один, и его визуальный тип — 'Hero'. Скрытого
 * здесь не найти по построению (HUD-1): чего нет в доставке, того нет и тут.
 */
function heroEntitySelector(state: HudDeliveredState): HudEntityView | null {
  for (const entity of state.entities.values()) {
    if (entity.kind === 'Hero') return entity;
  }
  return null;
}

/** Что сборка демо передаёт HUD — общие объекты `main.ts`, не собственность HUD. */
export interface DemoHudOptions {
  /** Контейнер вьюпорта (`#app`) — поверх него встаёт оверлей (HUD-3). */
  readonly container: Element;
  /** РАЗДЕЛЯЕМЫЙ asset-сервис рендера арены — один кэш на дерево (HUD-7, ASSET-2). */
  readonly assets: AssetService;
  /** Тот же манифест визуалов, что у подсистемы моделей (ASSET-6). */
  readonly visuals: VisualManifest;
  /** Источник сетки handshake — сам `RemoteHost` (SHELL-5, HUD-6). */
  readonly terrain: MinimapTerrainSource;
  /** Контракт камеры для presentation-действий (HUD-2) — реализует `main.ts`. */
  readonly camera: HudCameraContract;
  /** Обратный канал команд — сам `RemoteHost` (SHELL-6). */
  readonly control: HudControlChannel;
  /**
   * Источник слоя тумана миникарты (HUD-6) — подсистема тумана рендера
   * (структурно): та же маска и та же сила затемнения, что у fog-mask основного
   * вида (FOW-7, FOW-10). Сцена без тумана источника не передаёт.
   */
  readonly fog?: MinimapFogSource;
}

export interface DemoHud {
  readonly runtime: HudRuntime;
  /** Фасад действий — обычный источник ввода: `main.ts` добавляет его в сэмплер (HUD-2). */
  readonly facade: HudActionsFacade;
  /** Корень оверлея: `main.ts` по нему понимает, что курсор над интерактивом HUD. */
  readonly root: Element;
}

/**
 * События указателя, которые интерактив HUD перехватывает у вьюпорта (HUD-3).
 * Источники ввода демо слушают `window`, и без остановки всплытия клик по
 * кнопке HUD дошёл бы до `KeyboardMouseSource` как каст в точку кнопки.
 * До корня оверлея событие доходит ТОЛЬКО от интерактивных элементов — сам
 * корень и зоны для указателя прозрачны (`pointer-events: none`), поэтому
 * остановка здесь и есть «перехват в границах интерактива».
 */
// 'pointerdown' обязателен: TouchSource слушает pointer-события на window
// (input/touch.ts), и без него тап по кнопке HUD дошёл бы до стиковых зон.
const INTERCEPTED_POINTER_EVENTS = ['mousedown', 'pointerdown', 'click', 'wheel', 'touchstart'] as const;

/**
 * Реестры демо: виды виджетов, селекторы над доставленным состоянием и
 * действия (HUD-4). Отдельно от сборки HUD, потому что композиция резолвится
 * против РЕЕСТРОВ, а не против DOM: так «композиция демо валидна» проверяется
 * без браузера — тем же резолвом, который выполнит `apply`.
 */
export function createDemoHudRegistry(
  options: Pick<DemoHudOptions, 'assets' | 'visuals' | 'terrain' | 'fog'>,
): HudRegistry {
  const registry = new HudRegistry();
  registry.registerWidget(matchStatusKind);
  registry.registerWidget(cooldownsKind(iconSource));
  registry.registerWidget(
    minimapWidgetKind({
      terrain: options.terrain,
      ...(options.fog !== undefined ? { fog: options.fog } : {}),
    }),
  );
  registry.registerWidget(createPortraitKind({ assets: options.assets, visuals: options.visuals }));
  registry.registerWidget(hpBarKind);
  registry.registerWidget(deathsKind);
  registry.registerWidget(runtimeKind);

  registry.registerSelector('hero.entity', heroEntitySelector);
  registry.registerSelector('minimap.entities', minimapEntitiesSelector);
  registry.registerSelector('minimap.floor', minimapFloorSelector);
  // Все доставленные сущности: вход счётчиков смертей и рантайм-панели.
  // Скрытых туманом здесь нет по построению (HUD-1).
  registry.registerSelector('entities', (state: HudDeliveredState) => state.entities);

  // Мировые действия — имена словаря биндингов (INP-4): в воркер уходит тот же
  // канонический ввод, что от назначенной клавиши (HUD-2).
  registry.registerAction('hero.cast', { target: 'world', action: 'cast' });
  registry.registerAction('hero.dodge', { target: 'world', action: 'dodge' });
  registry.registerAction('hero.jump', { target: 'world', action: 'jump' });
  // Купол ловит фронт, захват — отпускание: фасад даёт кнопке ровно один тик с
  // битом, и следующий тик уже без него читается сценой как falling edge (INP-2).
  registry.registerAction('hero.slowDome', { target: 'world', action: 'slowDome' });
  registry.registerAction('hero.capture', { target: 'world', action: 'capture' });
  // Щит ловит фронт, как купол: каст-и-забыл, удержание ему ничего не даёт.
  registry.registerAction('hero.shield', { target: 'world', action: 'shield' });
  // Ульта отката — запись панели БЕЗ действия: она показывает кулдаун и только.
  //
  // Клик фасада даёт РОВНО ОДИН тик с битом (INP-2), то есть кастует ульту и в
  // тот же миг отпускает орган ведения скраба: мир замер бы, отмотался на один
  // шаг и продолжился — а ульта сгорела бы на весь свой cooldown. Кнопка,
  // тратящая способность впустую, хуже кнопки, которая ничего не делает.
  // Скраб — это УДЕРЖАНИЕ, и живёт оно на клавише (`bindings.json`).
  //
  // Слот действия при этом объявлен: виджет кулдаунов зовёт `trigger` по имени
  // способности, и запись без слота валила бы клик исключением (HUD-2).
  registry.registerAction('hero.rewind', { target: 'presentation', run: () => undefined });
  // Команды машины состояний мира — обратным каналом (SHELL-6, WSM-1); паузу
  // на экране поставит только доставленный режим, не клик (HUD-2).
  registry.registerAction('match.pause', { target: 'control', action: 'pause' });
  registry.registerAction('match.resume', { target: 'control', action: 'resume' });
  // Presentation-действие: клик миникарты → контракт камеры, локально в главном
  // потоке; в воркер не уходит ничего (HUD-2).
  registry.registerAction('camera.pan', {
    target: 'presentation',
    run: (camera, payload) => {
      if (typeof payload?.x === 'number' && typeof payload.y === 'number') {
        camera.panTo(payload.x, payload.y);
      }
    },
  });
  return registry;
}

/** Сборка HUD демо: реестры, оверлей-хост, фасад действий и исполнитель (HUD-4). */
export function createDemoHud(options: DemoHudOptions): DemoHud {
  const registry = createDemoHudRegistry(options);

  const host = new HudOverlayHost(options.container);
  for (const type of INTERCEPTED_POINTER_EVENTS) {
    host.root.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }

  const facade = new HudActionsFacade({
    actions: registry,
    camera: options.camera,
    control: options.control,
  });
  const runtime = new HudRuntime({ registry, host, actions: facade });
  return { runtime, facade, root: host.root };
}
