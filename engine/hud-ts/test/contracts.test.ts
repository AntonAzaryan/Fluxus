/**
 * Структурные контракты HUD ↔ оболочка (HUD-1, design Decision 6) на уровне
 * типов: пакет сознательно дублирует формы `client`/`render` структурно, и
 * этот файл прибивает совместимость к `npm run check` (typecheck). Разъедься
 * подписка HUD с `RemoteHost.register` или сузься доставленное состояние —
 * красной станет компиляция, а не первая доставка в рантайме.
 *
 * Только compile-time: `Assert`/`Extends` ломают tsc при несовместимости,
 * рантайм-утверждений здесь нет и не нужно.
 */
import { describe, expect, it } from 'vitest';
import type { InputSource, RemoteHost } from '@fluxus/client';
import type {
  HudActionsFacade,
  HudControlChannel,
  HudDeliveredState,
  HudRuntime,
} from '../src/index.js';

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
