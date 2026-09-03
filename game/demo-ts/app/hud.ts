/**
 * HUD демо на пакете `@fluxus/hud` (задача 5.2): композиция — декларативное
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
import type { AssetService, VisualManifest } from '@fluxus/assets';
import {
  HudActionsFacade,
  HudOverlayHost,
  HudRegistry,
  HudRuntime,
  cooldownsKind,
  createPortraitKind,
  deathsKind,
  hpBarKind,
  matchPauseSelector,
  matchStatusKind,
  minimapEntitiesSelector,
  minimapFloorSelector,
  minimapWidgetKind,
  pauseOverlayKind,
  runtimeKind,
  type HudAnchorSource,
  type HudCameraContract,
  type HudComposition,
  type HudControlChannel,
  type HudDeliveredState,
  type HudEntityView,
  HudIcons,
  type MinimapFogSource,
  type MinimapTerrainSource,
} from '@fluxus/hud';
import { COOLDOWN_ABILITIES, RESPAWN_EVENT, STATS } from './sim.js';

/**
 * Словарь причин отказа в паузе (`netcode-transport` NTR-20) — ДАННЫЕ демо, а
 * не строки виджета: смысл причин принадлежит игре, и оверлей показывает то,
 * что ему дала композиция (HUD-4, HUD-9). Причина без записи доезжает до экрана
 * своим ключом и потому видна, а не теряется.
 */
const PAUSE_DENY_LABELS: Readonly<Record<string, string>> = {
  'match-not-running': 'матч ещё не идёт',
  rewinding: 'идёт откат — паузу поставить нельзя',
  'not-a-player': 'наблюдатель паузу не ставит',
  'budget-spent': 'паузы на этот матч кончились',
  'already-frozen': 'пауза уже стоит',
  'already-resuming': 'матч уже возобновляется',
  'not-frozen': 'паузы нет',
  'too-early': 'чужую паузу пока снимать рано',
};

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
   * Пауза МАТЧА (NTR-20): её ставит сервер по запросу участника, и своей машины
   * состояний тонкому клиенту она не даёт. Поэтому в сетевом режиме кнопки
   * паузы существуют, а оверлей рисуется по ДОСТАВЛЕННОМУ состоянию паузы
   * (HUD-9), а не по режиму мира.
   *
   * В локальном режиме её нет: пауза одиночного прогона — переход WSM в воркере
   * (SHELL-6), сервера в этой сборке не существует вовсе.
   */
  readonly matchPause: boolean;
  /** Имена слотов матча для оверлея паузы: кто именно её поставил (HUD-9). */
  readonly slotNames?: readonly string[];
  /**
   * Длительность тика в миллисекундах — из handshake (SHELL-5). Оверлей
   * кулдауна переводит по ней доставленные ТИКИ в секунды (HUD-8): сам он не
   * тикает и своих часов не заводит.
   */
  readonly tickMs: number;
}

/**
 * Способности демо, которые кастуются УДЕРЖАНИЕМ органа управления (HUD-2).
 * Сегодня такая одна — ульта отката: фронт её включает, а тот же бит дальше
 * ведёт точку остановки, пока его держат (`ACTION_BITS.rewind`,
 * `rewind.holdButton` конфига матча). Форма — данные композиции: виджет о
 * смысле способности не знает.
 */
const HOLD_ABILITIES: ReadonlySet<string> = new Set(['rewind']);

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
        // Кнопки паузы есть у обеих сборок, но по разным основаниям: у локальной
        // это переход машины состояний её собственного воркера (SHELL-6), у
        // сетевой — запрос паузы МАТЧА серверу (NTR-20). Обратный канал у них
        // один и тот же, поэтому и запись композиции одна.
        params: { controls: capabilities.controls || capabilities.matchPause },
        ...(capabilities.controls || capabilities.matchPause
          ? { actions: { pause: 'match.pause', resume: 'match.resume' } }
          : {}),
        // Чем кнопка выбирает команду: сетевая сборка — ДОСТАВЛЕННЫМ состоянием
        // паузы матча (NTR-20), локальная — доставленным режимом своего мира
        // (умолчание виджета). Разница не косметическая: в заморозке матча
        // снапшотов нет вовсе, режим мира у клиента остаётся `Running`, и без
        // этого биндинга кнопка не смогла бы послать `resume` никогда (HUD-9).
        ...(capabilities.matchPause ? { bindings: { pauseState: 'match.pause.state' } } : {}),
      },
      // Оверлей паузы матча (HUD-9) — только там, где пауза матча существует:
      // в локальном прогоне сервера нет, состояние паузы никто не доставляет, и
      // виджет, которому нечего показывать, лучше не монтировать вовсе.
      ...(capabilities.matchPause
        ? [
            {
              widget: 'pause-overlay',
              zone: 'center' as const,
              params: {
                slotNames: [...(capabilities.slotNames ?? [])],
                denyLabels: PAUSE_DENY_LABELS,
              },
              bindings: { pause: 'match.pause.state' },
            },
          ]
        : []),
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
            // Форма органа управления (HUD-2): у ульты отката — удержание, у
            // остальных — фронт.
            hold: HOLD_ABILITIES.has(ability),
          })),
          // Сколько КНОПОК В РЯДУ (виджет пишет их числом колонок сетки):
          // семь способностей при четырёх в ряду ложатся в два ряда снизу по
          // центру (design D5). Прежняя двойка означала два столбца, то есть
          // четыре ряда, — вертикальную колонку вместо полосы.
          perRow: 4,
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
        // Полоса здоровья — НАД ГЕРОЕМ по мировому якорю (HUD-10), а не под
        // портретом: место на экране ей даёт проекция, которую публикует рендер
        // (`rendering` REND-41), и идёт она вместе с камерой. Зона записи
        // остаётся её домом в композиции; смещение поднимает полосу над
        // макушкой на десяток пикселей, чтобы она не села на неё вплотную.
        //
        // Виджет тот же, что стоял в зоне, и кода его это не коснулось ни
        // строкой: размещение объявлено записью (HUD-4, HUD-10).
        widget: 'hp-bar',
        zone: 'bottom-left',
        params: { stat: STATS.hp, maxStat: STATS.hpMax },
        bindings: { entity: 'hero.entity' },
        anchor: { entity: 'entity', offsetY: -10 },
      },
    ],
  };
}

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
  /**
   * Источник мировых якорей (HUD-10) — служба рендера (`rendering` REND-41).
   * Нет источника — якорные виджеты монтируются скрытыми: HUD без рендера
   * (headless-прогон, тест композиции) обязан собираться.
   */
  readonly anchors?: HudAnchorSource;
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
  // Иконки панели — ТОТ ЖЕ сервис ассетов, что у рендера арены и портрета
  // (HUD-4, HUD-7, ASSET-2): второго кэша над деревом контента нет, и второго
  // способа его адресовать — тоже.
  registry.registerWidget(cooldownsKind(new HudIcons(options.assets)));
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
  registry.registerWidget(pauseOverlayKind);

  registry.registerSelector('hero.entity', heroEntitySelector);
  registry.registerSelector('minimap.entities', minimapEntitiesSelector);
  registry.registerSelector('minimap.floor', minimapFloorSelector);
  // Все доставленные сущности: вход счётчиков смертей и рантайм-панели.
  // Скрытых туманом здесь нет по построению (HUD-1).
  registry.registerSelector('entities', (state: HudDeliveredState) => state.entities);
  // Доставленное состояние паузы матча (NTR-20). Имя с суффиксом `.state`, а не
  // `match.pause`: последнее уже занято ДЕЙСТВИЕМ «поставить паузу», а реестры
  // селекторов и действий разные — совпадение имён читалось бы как одно понятие.
  registry.registerSelector('match.pause.state', matchPauseSelector);

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
  // Ульта отката — обычное мировое действие, а её кнопка объявлена формой
  // «удержание» (`HOLD_ABILITIES` выше, HUD-2): фронт кастует ульту, а тот же
  // бит, пока его держат, ведёт точку остановки — ровно как удержание клавиши
  // из той же раскладки (`bindings.json`, INP-4). Прежней заглушки —
  // presentation-действия в никуда и пометки кнопки нерабочей — здесь больше
  // нет: живая на вид кнопка, которая ничего не делает, HUD-2 запрещена.
  registry.registerAction('hero.rewind', { target: 'world', action: 'rewind' });
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
  const runtime = new HudRuntime({
    registry,
    host,
    actions: facade,
    ...(options.anchors !== undefined ? { anchors: options.anchors } : {}),
  });
  return { runtime, facade, root: host.root };
}
