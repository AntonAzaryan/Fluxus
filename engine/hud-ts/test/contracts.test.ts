/**
 * Структурные контракты HUD ↔ оболочка (HUD-1, design Decision 6) на уровне
 * типов: пакет сознательно дублирует формы `client`/`render` структурно, и
 * этот файл прибивает совместимость к `npm run check` (typecheck). Разъедься
 * подписка HUD с `RemoteHost.register` или сузься доставленное состояние —
 * красной станет компиляция, а не первая доставка в рантайме.
 *
 * Типовая часть — только compile-time: `Assert`/`Extends` ломают tsc при
 * несовместимости. Рантайм-проверка здесь одна и по делу: подписка HUD стоит в
 * общем списке подсистем сцены, а значит обязана объявить свою стоимость
 * (`render-quality` QUAL-3), и принять это объявление должен настоящий
 * контроллер качества, а не копия его правил рядом.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AssetService } from '@fluxus/assets';
import type { InputSource, RemoteHost } from '@fluxus/client';
import { PresentationStage, QualityController, type RenderContext } from '@fluxus/render';
import { HudActionsFacade, HudOverlayHost, HudRegistry, HudRuntime } from '../src/index.js';
import type { HudControlChannel, HudDeliveredState } from '../src/index.js';
import { asElement, fakeDom } from './support/fakeDom.js';
import { CameraSpy } from './support/hud.js';

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

/** Форма подсистемы, которую принимает точка доставки главного потока. */
type RegisteredSubsystem = Parameters<RemoteHost['register']>[0];
/** Настоящий доставленный view — тот, что приезжает подсистемам в syncTick. */
type DeliveredView = Parameters<RegisteredSubsystem['syncTick']>[0];

/** Подписка HUD регистрируется в `RemoteHost.register` наравне с подсистемами. */
type _SubsystemRegisters = Assert<Extends<HudRuntime['subsystem'], RegisteredSubsystem>>;
/** Доставленный view читается селекторами как `HudDeliveredState` — сужение законно. */
type _ViewIsDeliveredState = Assert<Extends<DeliveredView, HudDeliveredState>>;
/** `RemoteHost` — обратный канал команд фасада (SHELL-6). */
type _HostIsControlChannel = Assert<Extends<RemoteHost, HudControlChannel>>;
/** Фасад действий — обычный источник ввода сэмплера (INP-1, HUD-2). */
type _FacadeIsInputSource = Assert<Extends<HudActionsFacade, InputSource>>;

describe('структурные контракты HUD ↔ оболочка (HUD-1)', () => {
  it('проверены компилятором: несовместимость — ошибка typecheck, не рантайма', () => {
    expect(true).toBe(true);
  });
});

describe('подписка HUD объявляет свою стоимость (QUAL-3)', () => {
  function hudRuntime(): HudRuntime {
    const registry = new HudRegistry();
    const host = new HudOverlayHost(asElement(fakeDom().container));
    const actions = new HudActionsFacade({ actions: registry, camera: new CameraSpy() });
    return new HudRuntime({ registry, host, actions });
  }

  function stage(): PresentationStage {
    const context: RenderContext = {
      scene: new THREE.Scene(),
      assets: {} as AssetService,
      config: { heightStep: 0.6 },
    };
    return new PresentationStage(context);
  }

  it('называет причину константности, а ручек не заводит', () => {
    const declaration = hudRuntime().subsystem.quality();

    expect(declaration.subsystem).toBe('match-hud');
    expect(declaration.knobs).toEqual([]);
    // Пустой список БЕЗ причины — то самое «ни то, ни другое», которое QUAL-3
    // объявляет дефектом.
    expect(declaration.constantCost).toBeTruthy();
  });

  it('настоящий контроллер качества принимает её и не находит у HUD ручек', () => {
    const scene = stage();
    scene.register(hudRuntime().subsystem);

    // Регистрация не бросает — декларация законна; реестр ручек от HUD не
    // растёт, потому что стоимостных осей у него нет.
    const controller = new QualityController(scene);
    expect(controller.knobs).toEqual([]);
  });
});
