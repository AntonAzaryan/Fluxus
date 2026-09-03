/**
 * Отладочный слой рендера (`render-debug` RDBG-1, RDBG-4, RDBG-8) и его точка
 * подключения к сцене подсистем (`rendering` REND-27).
 *
 * ## Рядом со списком подсистем, а не внутри него (REND-27)
 *
 * Слой НЕ `RenderSubsystem`, и источник — тем более не подсистема. Форма
 * подключения — та же, что у контроллера качества (`render-quality` QUAL-1):
 * слой подписывается на регистрации сцены и спрашивает объявление ОДИН раз, при
 * регистрации подсистемы. Причины две, и каждой хватило бы по отдельности:
 *
 * - **счётчики.** Длина списка подсистем — аргумент счётных величин стоимости
 *   (`performance-budget` PERF-3: доставки × подсистемы, живые × подсистемы).
 *   Слой, приходящий и уходящий по галочке разработчика, двигал бы счётчики
 *   матча, к отладке отношения не имеющего, и голден-эталон стоимости (PERF-4)
 *   зависел бы от настроек чужой сборки (RDBG-8). Ни одного обращения к стоку
 *   счётчиков в этом файле нет и быть не должно;
 * - **порядок.** Порядок подсистем нормирован и содержателен (REND-8):
 *   наложение рисуется по позам, которые подсистема моделей ставит в своём
 *   покадровом обновлении. Слой внутри списка потребовал бы отдельного правила о
 *   своём месте — вне списка он последний по построению.
 *
 * ## Инертность выключенного (RDBG-4)
 *
 * Без единого включённого источника кадр слоя — одно сравнение: проб не
 * считается, наложений не рисуется, сценовых объектов у слоя нет. Включение и
 * выключение действуют на живой сцене: пересборки рендера, перезапуска матча и
 * переинициализации подсистем не требуется — по образцу применения пресета
 * качества (QUAL-1).
 *
 * ## Две грани над одной пробой (RDBG-2)
 *
 * И наложение, и дамп получаются ОДНОЙ функцией `probe(state)` на ОДНОМ
 * состоянии кадра. Дамп снимается ПО ЗАПРОСУ (RDBG-7) — покадровая сборка была
 * бы аллокацией на кадр ради данных, которых никто не читает, — и берёт то же
 * состояние, на котором нарисован последний кадр.
 */
import type { PresentationStage } from '../stage.js';
import type { RenderSubsystem, TickView } from '../types.js';
import type { DebugFrameState, DebugProbe, DebugSource } from './contract.js';
import { DEBUG_DUMP_VERSION, dumpClock, dumpSection, type DebugDump } from './dump.js';
import { DebugPainter, type DebugPainterOptions } from './painter.js';

/** Запись реестра для панели встраивающего приложения (политика — её). */
export interface DebugSourceInfo {
  readonly id: string;
  /** Владелец — часть `id` до первой точки: по нему панель группирует список. */
  readonly owner: string;
  readonly title: string;
  readonly enabled: boolean;
  /** Источнику есть что рисовать; нет — он живёт только в дампе. */
  readonly drawable: boolean;
}

/** Сглаживание оценки частоты кадров: величина часовая, дрожать ей незачем. */
const FPS_SMOOTHING = 0.1;

const IDLE_STATE: DebugFrameState = {
  view: null,
  alpha: 0,
  dtSeconds: 0,
  realDtSeconds: 0,
};

/**
 * Мутабельный близнец состояния кадра. Своя точка у сцены (REND-27) зовётся
 * каждый кадр, и объектный литерал в аргументе был бы аллокацией на кадр
 * (RDBG-4, REND-26) — поля переписываются, объект живёт.
 */
interface MutableFrameState {
  view: TickView | null;
  alpha: number;
  dtSeconds: number;
  realDtSeconds: number;
}

interface Entry {
  readonly source: DebugSource;
  enabled: boolean;
}

export type RenderDebugLayerOptions = DebugPainterOptions;

export class RenderDebugLayer {
  private readonly entries: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly painter: DebugPainter;
  private state: DebugFrameState = IDLE_STATE;
  /** Состояние кадра своей точки у сцены: переиспользуется между кадрами. */
  private readonly hookState: MutableFrameState = {
    view: null,
    alpha: 0,
    dtSeconds: 0,
    realDtSeconds: 0,
  };
  /** Последнее доставленное состояние сцены; null — доставок не было. */
  private delivered: TickView | null = null;
  private activeCount = 0;
  private fps = 0;
  /** Кадров слоя с включённой отладкой — по нему видно, что слой живой. */
  private frames = 0;

  constructor(stage: PresentationStage, options: RenderDebugLayerOptions = {}) {
    this.painter = new DebugPainter(options);
    // Подписка сразу отдаёт уже зарегистрированные подсистемы, а дальше зовётся
    // на каждую новую: ранняя и поздняя регистрация неразличимы (REND-27).
    stage.watchRegistrations((subsystem) => {
      this.attach(subsystem);
    });
    // Вторая точка того же подключения: доставленное состояние и кадровые
    // величины (REND-27). Встраивающей сборке не приходится вести слой самой —
    // и не приходится второй раз выводить альфу интерполяции (SHELL-7), которую
    // сцена уже раздала подсистемам.
    stage.watchFrames({
      deliver: (view) => {
        this.delivered = view;
      },
      frame: (dt, alpha, realDt) => {
        // Выключенная отладка стоит РОВНО ОДНОГО СРАВНЕНИЯ (RDBG-4): до сборки
        // состояния кадра дело не доходит — ни объекта, ни записи полей. Тот же
        // смысл, в каком инертен неподключённый сток счётчиков (PERF-3).
        if (this.activeCount === 0) return;
        const state = this.hookState;
        state.view = this.delivered;
        state.alpha = alpha;
        state.dtSeconds = dt;
        state.realDtSeconds = realDt;
        this.frame(state);
      },
    });
  }

  /** Реестр глазами панели: `id`, владелец, подпись и состояние переключателя. */
  get sources(): readonly DebugSourceInfo[] {
    return this.entries.map((entry) => ({
      id: entry.source.id,
      owner: ownerOf(entry.source.id),
      title: entry.source.title ?? entry.source.id,
      enabled: entry.enabled,
      drawable: entry.source.draw !== undefined,
    }));
  }

  /**
   * Включённые источники в порядке регистрации — состав секций дампа (RDBG-7).
   * Массив здесь строится, поэтому спрашивать его покадрово нельзя: «включена
   * ли отладка вообще» отвечает `enabledCount` (RDBG-4).
   */
  get enabled(): readonly string[] {
    return this.entries.filter((entry) => entry.enabled).map((entry) => entry.source.id);
  }

  /**
   * Сколько источников включено. Дешёвый ответ на вопрос «работает ли отладка»:
   * встраивающей сборке он нужен каждый кадр, и материализовать ради него
   * перечень `enabled` значило бы платить за выключенную отладку (RDBG-4).
   */
  get enabledCount(): number {
    return this.activeCount;
  }

  /** Сценовых объектов слоя; 0 — кадр тот же, что без слоя вовсе (RDBG-4). */
  get objectCount(): number {
    return this.painter.objectCount;
  }

  /** Вершин в текущем наборе наложений — вход тестов инертности. */
  get vertexCount(): number {
    return this.painter.vertexCount;
  }

  /** Кадров, на которых слой действительно работал (был включён хоть один источник). */
  get frameCount(): number {
    return this.frames;
  }

  /**
   * Регистрация источника (RDBG-1). Повторный `id` отвергается АДРЕСНО — с
   * именем источника и его владельцем: молчаливое затирание одного источника
   * другим ровно то, ради отсутствия чего у реестра есть имена. Ранее
   * зарегистрированный при этом остаётся в реестре нетронутым.
   */
  register<P extends DebugProbe>(source: DebugSource<P>): this {
    const id = source.id;
    const owner = ownerOf(id);
    if (owner === '' || owner === id) {
      throw new Error(
        `RenderDebugLayer: источник "${id}" вне неймспейса владельца — ожидалось "<владелец>.<источник>" (RDBG-1)`,
      );
    }
    if (this.byId.has(id)) {
      throw new Error(
        `RenderDebugLayer: отладочный источник "${id}" уже зарегистрирован владельцем "${owner}" — ` +
          'двух владельцев у одной оси наблюдения не бывает (RDBG-1)',
      );
    }
    const entry: Entry = { source: source, enabled: false };
    this.entries.push(entry);
    this.byId.set(id, entry);
    return this;
  }

  /** Знает ли реестр этот `id` — вход восстановления сохранённого выбора. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  isEnabled(id: string): boolean {
    return this.byId.get(id)?.enabled ?? false;
  }

  /**
   * Переключатель ОДНОГО источника (RDBG-1): включаются и выключаются они по
   * отдельности, а не режим целиком. Незнакомый `id` — `false`, а не отказ:
   * восстановление сохранённого выбора не тот повод, чтобы ронять страницу.
   *
   * Выключение убирает наложение из кадра целиком (RDBG-4): набор
   * пересобирается ближайшим кадром, а последний выключенный источник снимает
   * группу слоя со сцены.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const entry = this.byId.get(id);
    if (entry === undefined) return false;
    if (entry.enabled === enabled) return true;
    entry.enabled = enabled;
    this.activeCount += enabled ? 1 : -1;
    entry.source.toggle?.(enabled);
    if (this.activeCount === 0) this.painter.clear();
    return true;
  }

  /**
   * Кадр слоя. Выключенная отладка стоит ровно одного сравнения (RDBG-4): ни
   * пробы, ни обхода источников, ни касания сцены. Счётчиков стоимости этот путь
   * не трогает вовсе (RDBG-8).
   */
  frame(state: DebugFrameState): void {
    if (this.activeCount === 0) return;
    this.state = state;
    this.frames += 1;
    const seconds = state.realDtSeconds;
    if (seconds > 0) {
      const sample = 1 / seconds;
      this.fps = this.fps === 0 ? sample : this.fps + (sample - this.fps) * FPS_SMOOTHING;
    }
    this.painter.begin();
    for (const entry of this.entries) {
      if (!entry.enabled) continue;
      const probe = entry.source.probe(state);
      if (probe.noData !== undefined) continue;
      this.painter.owner(entry.source.id);
      // Источнику отдаётся СЛОВАРЬ примитивов, а не painter: жизненный цикл
      // набора и сцена — дело слоя, и в руки источника они не попадают (RDBG-3).
      entry.source.draw?.(probe, this.painter.primitives);
    }
    this.painter.commit();
  }

  /**
   * Точка освобождения слоя (REND-31, ED-15): рисовальщик отдаёт свои носители
   * и плашки, а сцена — группу наложений. Слой НЕ подсистема (REND-27), и
   * `PresentationStage.dispose` его не видит: зовёт его владелец — сборка,
   * сносящая вьюпорт. Без этого каждый снос сцены редактора терял бы геометрии,
   * материалы и текстуры владельца `debug`, которых учёт (PERF-8) ждёт нулём.
   *
   * Источники после сноса остаются в реестре, но рисовать им нечем: слой
   * снимается вместе со своим вьюпортом, а не выключается на живом.
   */
  dispose(): void {
    this.painter.dispose();
  }

  /**
   * Дамп кадра (RDBG-7) — по запросу, а не покадрово. Пробы снимаются заново на
   * ТОМ ЖЕ состоянии, на котором нарисован последний кадр: наложение и дамп
   * поэтому описывают одно состояние по построению, а два дампа на одном входе
   * совпадают, кроме названной отдельно секции часовых величин.
   */
  dump(): DebugDump {
    const state = this.state;
    const view = state.view;
    const sections: Record<string, unknown> = {};
    const clock: Record<string, number> = {
      'frame.alphaTickFraction': state.alpha,
      'frame.framesPerSecond': this.fps,
      'frame.worldClockSeconds': state.dtSeconds,
      'frame.realClockSeconds': state.realDtSeconds,
    };
    const enabled: string[] = [];
    for (const entry of this.entries) {
      // Секции выключенного источника в дампе НЕТ — «выключено» и «данных нет»
      // обязаны различаться (RDBG-7).
      if (!entry.enabled) continue;
      enabled.push(entry.source.id);
      const probe: DebugProbe = entry.source.probe(state);
      sections[entry.source.id] = dumpSection(entry.source.id, probe);
      dumpClock(entry.source.id, probe, clock);
    }
    return {
      version: DEBUG_DUMP_VERSION,
      tick: view?.tick ?? -1,
      mode: (view?.mode ?? 'none'),
      enabled,
      clock,
      sections,
    };
  }

  /**
   * Объявление источников подсистемой в точке её регистрации (REND-27).
   * Объявление НЕОБЯЗАТЕЛЬНО: подсистема, которой нечего показывать, его не
   * имеет, и дефектом это не является — в отличие от объявления стоимостной
   * ручки (QUAL-3), обязательного для растущей стоимости.
   */
  private attach(subsystem: RenderSubsystem): void {
    const declared = subsystem.debugSources?.();
    if (declared === undefined) return;
    for (const source of declared) {
      if (!source.id.startsWith(`${subsystem.name}.`)) {
        throw new Error(
          `RenderDebugLayer: подсистема "${subsystem.name}" объявила источник "${source.id}" ` +
            `вне своего неймспейса — ожидалось "${subsystem.name}.<источник>" (RDBG-1)`,
        );
      }
      this.register(source);
    }
  }
}

/**
 * Владелец `id` — часть до первой точки (`fog.mask` → `fog`). Наружу пакета не
 * выдаётся: панели встраивающего приложения владелец приезжает готовым полем
 * `DebugSourceInfo.owner`, и второго способа его посчитать не заводится.
 */
function ownerOf(id: string): string {
  const at = id.indexOf('.');
  return at <= 0 ? '' : id.slice(0, at);
}
