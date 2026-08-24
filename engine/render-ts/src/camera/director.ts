/**
 * Диспетчер эффектов камеры (CAM-6): связывает данные симуляции со стеком
 * эффектов по таблицам манифеста визуалов (ASSET-8). Механизм — типы
 * эффектов в коде (`effects.ts`); политика — какие события и состояния их
 * вызывают и с какими числами — только манифест.
 *
 * Ветвлений по конкретному типу эффекта здесь нет ни одного, и это нормативно
 * (CAM-6): перечень типов, набранный ветвлениями, — тот самый второй перечень,
 * которого CAM-9 не допускает, и именно он делает добавление типа правкой
 * чужого кода. Диспетчер знает только описание: по `def.effect` находится
 * дескриптор, его вид сверяется с таблицей записи, числа собираются по
 * объявленным параметрам, после чего зовётся фабрика. Свойство пиннится
 * сканером исходника (`test/cameraEffects.test.ts`) — обычным прогоном оно не
 * ловится: ветка, добавленная «на время», работает.
 *
 * Двух видов эффектов диспетчер при этом не скрывает, и это не то же самое:
 * вид — часть формата секции (две таблицы, ASSET-8) и часть описания (CAM-9), а
 * не перечень типов. Импульсным нужен `trigger`, длящимся — `setActive`, и
 * держатся они в разных таблицах инстансов — оттого приведений типа в файле
 * нет ни одного.
 *
 * Импульсные эффекты — от событий тика; срабатывают только на «честных»
 * тиках (`freshEvents`): при rewind/replay догоняющий реплей не стреляет
 * очередью накопленных тряск (CAM-5, CAM-6). Длящиеся — от присутствия
 * состояния на сущности-цели в снапшоте (`EntityView.states`).
 */
import { FIXED_ONE, type EntityId } from '@fluxus/core';
import {
  cameraEffectParams,
  clampCameraEffectParam,
  type CameraEffectDef,
  type CameraEffectKind,
  type CameraEffectTypeSpec,
  type CameraEffectsDescription,
  type CameraEffectsSection,
} from '@fluxus/assets';
import type { TickView } from '../types.js';
import {
  EffectStack,
  type ImpulseEffect,
  type ImpulseEffectType,
  type LastingEffect,
  type LastingEffectType,
} from './effects.js';
import { CAMERA_EFFECTS_DESCRIPTION, type CameraEffectsCatalog } from './effectTypes.js';
import { createWarnOnce } from '../warnOnce.js';

export interface CameraEffectsDirectorOptions {
  /** Таблицы «событие/состояние → эффект» из манифеста (ASSET-8). */
  readonly tables?: CameraEffectsSection | undefined;
  /**
   * Машинное описание типов (CAM-9); по умолчанию — описание этой сборки
   * камеры. Параметром оно ради теста и ради потребителя со своей сборкой
   * эффектов: подставленное описание с новым типом обязано работать
   * end-to-end без правки этого файла.
   */
  readonly description?: CameraEffectsCatalog;
  /**
   * Упорядоченный список компонент-состояний, зеркалируемых в
   * `EntityView.states` (конфиг Extractor'а той же сборки): имя из таблицы
   * `states` манифеста ищется в этом списке.
   */
  readonly stateComponents?: readonly string[];
  readonly stack?: EffectStack;
  /** Канал предупреждений; по умолчанию console.warn. */
  readonly warn?: (message: string) => void;
}

/** Вид эффекта, законный в таблице секции (ASSET-8). */
const EVENTS_KIND = 'impulse';
const STATES_KIND = 'lasting';

/**
 * Числа записи по объявленным параметрам типа (CAM-9): значение из записи,
 * иначе умолчание; вне диапазона — к границе. Кадр не место, где отказывают
 * (CAM-6): о том же значении редактор отчитается ошибкой (ASSET-8), но слой
 * эффектов манифест не правит.
 */
function paramsOf(
  description: CameraEffectsDescription,
  type: CameraEffectTypeSpec,
  def: CameraEffectDef,
): Readonly<Record<string, number>> {
  const params: Record<string, number> = {};
  for (const spec of cameraEffectParams(description, type)) {
    const value = def[spec.name];
    params[spec.name] =
      typeof value === 'number' && Number.isFinite(value)
        ? clampCameraEffectParam(spec, value)
        : spec.defaultValue;
  }
  return params;
}

/** Параметр привязки записи — по описанию, а не по литералу ключа (CAM-9). */
function bindingValue(
  description: CameraEffectsDescription,
  kind: CameraEffectKind,
  def: CameraEffectDef,
  name: string,
): number {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
  const spec = description.binding[kind]?.find((param) => param.name === name);
  const value = def[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec?.defaultValue ?? 0;
  return spec === undefined ? value : clampCameraEffectParam(spec, value);
}

export class CameraEffectsDirector {
  readonly stack: EffectStack;

  private readonly tables: CameraEffectsSection;
  private readonly description: CameraEffectsCatalog;
  private readonly stateComponents: readonly string[];
  /** Инстансы эффектов по ключу записи; создаются лениво и живут в стеке. */
  private readonly impulses = new Map<string, ImpulseEffect>();
  private readonly lastings = new Map<string, LastingEffect>();
  /** Предупреждение на запись — один раз (ASSET-8); механизм общий с подсистемами. */
  private readonly warnOnce: (key: string, message: string) => void;

  constructor(options: CameraEffectsDirectorOptions = {}) {
    this.tables = options.tables ?? {};
    this.description = options.description ?? CAMERA_EFFECTS_DESCRIPTION;
    this.stateComponents = options.stateComponents ?? [];
    this.stack = options.stack ?? new EffectStack();
    this.warnOnce = createWarnOnce(options.warn);
  }

  /**
   * Синхронизация с тиком: события → импульсы, состояния цели → длящиеся.
   * `focusX/focusY` — точка наблюдения камеры, центр затухания по
   * расстоянию (CAM-6).
   */
  onTick(view: TickView, focusX: number, focusY: number, targetId: EntityId | null): void {
    // Множитель 0 — полное отключение: события и состояния игнорируются (CAM-6).
    if (this.stack.multiplier === 0) return;
    this.applyImpulses(view, focusX, focusY);
    this.applyStates(view, targetId);
  }

  private applyImpulses(view: TickView, focusX: number, focusY: number): void {
    const events = this.tables.events;
    if (events === undefined || !view.freshEvents) return;
    for (const event of view.events) {
      const def = events[event.type];
      if (def === undefined) continue;
      const key = `event:${event.type}`;
      let effect = this.impulses.get(key);
      if (effect === undefined) {
        const type = this.typeOf(key, def, EVENTS_KIND, event.type);
        if (type === null) continue;
        effect = type.create(paramsOf(this.description, type, def));
        this.impulses.set(key, effect);
        this.stack.add(effect);
      }
      const amplitude = bindingValue(this.description, EVENTS_KIND, def, 'amplitude');
      effect.trigger(amplitude * this.falloff(view, event.data, focusX, focusY, def));
    }
  }

  private applyStates(view: TickView, targetId: EntityId | null): void {
    const states = this.tables.states;
    if (states === undefined) return;
    const target = targetId === null ? undefined : view.entities.get(targetId);
    for (const [component, def] of Object.entries(states)) {
      const key = `state:${component}`;
      let effect = this.lastings.get(key);
      if (effect === undefined) {
        const type = this.typeOf(key, def, STATES_KIND, component);
        if (type === null) continue;
        const bit = this.stateComponents.indexOf(component);
        if (bit < 0) {
          this.warnOnce(
            `state-bit:${component}`,
            `камера: состояние "${component}" не зеркалируется Extractor'ом (stateComponents) — эффект не активируется`,
          );
          continue;
        }
        effect = type.create(paramsOf(this.description, type, def));
        this.lastings.set(key, effect);
        this.stack.add(effect);
      }
      const bit = this.stateComponents.indexOf(component);
      const active = bit >= 0 && target !== undefined && ((target.states >>> bit) & 1) === 1;
      effect.setActive(active);
    }
  }

  /**
   * Ослабление импульса расстоянием от точки наблюдения (CAM-6): позиция
   * события — поля `x`/`y` (Q16.16), иначе позиция сущности `entity`/`source`
   * из снапшота, иначе — без ослабления. `radius` — параметр привязки, и
   * читается он по описанию (CAM-9), а не по литералу ключа.
   *
   * Деление на `FIXED_ONE` здесь — единственное место, где fixed-point живёт за
   * входной границей рендера (REND-1): полезная нагрузка события копируется
   * поле в поле, а какие её поля координатные, знает контент, а не рендер (см.
   * `RenderEvent.data` в `types.ts`).
   */
  private falloff(
    view: TickView,
    data: Readonly<Record<string, number>>,
    focusX: number,
    focusY: number,
    def: CameraEffectDef,
  ): number {
    const radius = bindingValue(this.description, EVENTS_KIND, def, 'radius');
    if (!Number.isFinite(radius) || radius <= 0) return 1;
    let x: number | null = null;
    let y: number | null = null;
    if (data.x !== undefined && data.y !== undefined) {
      x = data.x / FIXED_ONE;
      y = data.y / FIXED_ONE;
    } else {
      const source = data.entity ?? data.source;
      const entity = source === undefined ? undefined : view.entities.get(source);
      if (entity !== undefined) {
        x = entity.currX;
        y = entity.currY;
      }
    }
    if (x === null || y === null) return 1;
    const distance = Math.hypot(x - focusX, y - focusY);
    return Math.min(Math.max(1 - distance / radius, 0), 1);
  }

  /**
   * Дескриптор типа записи или `null` — запись пропущена: тип не объявлен
   * описанием либо объявлен эффектом другого вида, чем таблица, в которой
   * запись лежит (CAM-6). И то и другое — предупреждение, а не отказ слоя, и
   * говорится оно один раз на запись (ASSET-8).
   */
  private typeOf(key: string, def: CameraEffectDef, kind: 'impulse', where: string): ImpulseEffectType | null;
  private typeOf(key: string, def: CameraEffectDef, kind: 'lasting', where: string): LastingEffectType | null;
  private typeOf(
    key: string,
    def: CameraEffectDef,
    kind: CameraEffectKind,
    where: string,
  ): ImpulseEffectType | LastingEffectType | null {
    const type = this.description.types.find((candidate) => candidate.id === def.effect);
    if (type === undefined) {
      this.warnOnce(
        key,
        `камера: эффект "${def.effect}" ("${where}") описанием не объявлен — запись пропущена`,
      );
      return null;
    }
    if (type.kind !== kind) {
      this.warnOnce(
        key,
        `камера: эффект "${def.effect}" ("${where}") объявлен как ${type.kind}, а запись лежит в таблице ${kind} — запись пропущена`,
      );
      return null;
    }
    return type;
  }
}
