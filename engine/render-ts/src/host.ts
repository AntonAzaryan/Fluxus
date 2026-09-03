/**
 * RenderHost — рендер как внешний наблюдатель симуляции (REND-1) в
 * однопоточной сборке: `Extractor` и `ViewBuffer` соединены прямым вызовом.
 *
 * `onTick` — единственное место контакта с ядром: Extractor копирует минимум
 * из `TickResult` в плоскую форму (OBS-3, конверсия Q16.16 → float — REND-1),
 * ViewBuffer ведёт интерполяционный буфер, хост зовёт подсистемы. Та же пара,
 * разнесённая по потокам каналом оболочки, — воркер-сборка (`client-shell`
 * SHELL-2); подсистемы разницы не видят.
 *
 * Кадр отвязан от тика (REND-2): `frame(now)` считает альфу интерполяции и
 * зовёт подсистемы. Подсистемы (REND-8) вызываются строго в порядке
 * регистрации. Обратного канала нет: хост не вызывает ни одного мутирующего
 * API мира и не является зависимостью ядра.
 *
 * Реестр подсистем и кадр живут в `PresentationStage` — общей части продюсеров
 * presentation-состояния (REND-11). Хост от этого остаётся ровно `TickObserver`:
 * документных веток в нём нет, а второй продюсер (`DocumentSource`) пользуется
 * той же сценой, не заглядывая сюда.
 */
import { world, type EntityId, type TickObserver, type TickResult, type WorldState } from '@fluxus/core';
import { Extractor } from './extractor.js';
import { ViewBuffer, tickStreamFrame } from './viewBuffer.js';
import { PresentationStage, type PresentationProducer } from './stage.js';
import type { RenderContext, RenderHostConfig, RenderSubsystem, TickView } from './types.js';

/**
 * Резолвер визуального типа по тегам сущности: ядро не хранит имя prefab'а,
 * но теги prefab'а копируются на сущность при спавне. Кандидаты — ключи
 * манифеста визуалов (связь «манифест → sim-идентификатор», ASSET-6).
 */
export function kindByTags(
  kinds: readonly string[],
): (state: WorldState, entity: EntityId) => string | null {
  return (state, entity) => {
    for (const kind of kinds) {
      if (world.hasTag(state, entity, kind)) return kind;
    }
    return null;
  };
}

export class RenderHost implements TickObserver, PresentationProducer {
  readonly name = 'render';

  private readonly presentation: PresentationStage;
  private readonly extractor: Extractor;
  private readonly buffer: ViewBuffer;

  constructor(context: RenderContext, config: RenderHostConfig) {
    this.presentation = config.stage ?? new PresentationStage(context);
    // Конфиг хоста РАСШИРЯЕТ конфиг сборки (`RenderHostConfig`), поэтому едет
    // в неё целиком: пересказ полей по одному был бы вторым их списком.
    this.extractor = new Extractor(config);
    this.buffer = new ViewBuffer({
      tickSeconds: config.tickSeconds,
      ...(config.snapDistance !== undefined ? { snapDistance: config.snapDistance } : {}),
      ...(config.terrainGrid !== undefined
        ? { floorBits: new Uint8Array(config.terrainGrid.floor) }
        : {}),
      ...(config.clock !== undefined ? { clock: config.clock } : {}),
      ...(config.timeScale !== undefined ? { timeScale: config.timeScale } : {}),
    });
  }

  /** Presentation-состояние последнего тика; подсистемы получают его в syncTick. */
  get view(): TickView {
    return this.buffer.view;
  }

  /** Сцена подсистем — общая с документным источником, когда его завёл редактор (REND-11). */
  get stage(): PresentationStage {
    return this.presentation;
  }

  /**
   * Мировой множитель хода часов презентации (REND-25) — slow-motion реплея,
   * скорость скраба, заморозка фото-режима. Живёт в буфере: `dt` подсистемам
   * выдаёт он, и второго места, где решается ход времени, быть не должно.
   */
  setTimeScale(scale: number): void {
    this.buffer.setTimeScale(scale);
  }

  /** Действующий мировой множитель хода (REND-25). */
  get timeScale(): number {
    return this.buffer.timeScale;
  }

  /** Регистрирует подсистему; порядок регистрации = порядок вызовов (REND-8). */
  register(subsystem: RenderSubsystem): this {
    this.presentation.register(subsystem);
    return this;
  }

  onTick(result: TickResult): void {
    this.buffer.apply(this.extractor.extract(result));
    // Кадр доставлен тем же вызовом, каким извлечён: канала здесь нет, и
    // конфляции (SHELL-4) — тоже. Зеркало частичного кадра (SHELL-3) двигает
    // именно ФАКТ доставки, поэтому однопоточная сборка говорит о нём сразу.
    this.extractor.markDelivered();
    // Публикация потоком тиков: если состояние наполнял документный источник,
    // его набор гасится здесь же — объект не попадёт в кадр дважды (REND-11).
    this.presentation.publish(this, this.buffer.view);
  }

  /**
   * Кадр: dt и альфа между двумя последними тиками, затем `updateFrame`
   * подсистем в порядке регистрации (REND-2, REND-8). `now` — миллисекунды
   * тех же часов, что `config.clock`. Пока presentation-состояние наполняет
   * другой продюсер (режим правки, REND-11), кадр не рисуется — подсистемы уже
   * ведёт он, — а часы кадра сбрасываются, чтобы первый кадр после возвращения
   * не доигрывал накопленный простой.
   *
   * Тело общее с `RemoteHost.frame` (`client-shell` SHELL-2): продюсер потока
   * тиков у них один, и разница только в том, откуда приехал тик.
   */
  frame(now?: number): void {
    tickStreamFrame(this.presentation, this, this.buffer, now);
  }
}
