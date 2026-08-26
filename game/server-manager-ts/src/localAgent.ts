/**
 * Локальный агент менеджера (`server-manager` MGR-5, решение D6): его адрес и
 * материал автопейринга приходят ЧЕРЕЗ ОБЪЯВЛЕННЫЙ СЕРВИС десктоп-контейнера, а
 * не зашиваются в приложение.
 *
 * Страница называет контейнеру ОДНО — идентификатор сервиса из объявления
 * профиля (DSK-7), — и получает строку адреса. Контейнер эту строку не строит и
 * не разбирает: её пишет сам агент, а истолковывает вот этот модуль. Отсюда и
 * форма: обычный URL, в параметрах которого едут код пейринга и отпечаток.
 *
 * Ни одной константы адреса здесь нет и быть не может. Порт, отпечаток и код —
 * всё это свойства ЗАПУЩЕННОГО агента, и приложение, которое их знает заранее,
 * знает их неправильно.
 *
 * Форма моста приезжает КОНТРАКТОМ контейнера (`desktop-shell` DSK-2), а не
 * описывается здесь второй раз: направление зависимости «приложение → контракт»
 * ровно то же, каким пользуется десктопный хост среды редактора (ED-12).
 */
import { desktopBridgeOf, type DesktopBridge } from '@fluxus/desktop-shell/bridge';

/** Что менеджер вынимает из адреса, отданного контейнером. */
export interface LocalAgentAddress {
  /** Адрес управляющего эндпоинта без параметров: `wss://127.0.0.1:8443`. */
  readonly url: string;
  /** Код автопейринга; пустая строка — агент его не предъявил. */
  readonly pairingCode: string;
  /** Отпечаток сертификата, названный самим агентом; пустая строка — не назван. */
  readonly fingerprint: string;
}

/**
 * Разбор адреса сервиса. Пустая строка и мусор — `undefined`, а не адрес с
 * подставленными умолчаниями: менеджер, подключившийся «куда-то по умолчанию»,
 * показал бы админу чужие серверы.
 */
export function parseLocalAgentAddress(address: string): LocalAgentAddress | undefined {
  if (address === '') return undefined;
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    return undefined;
  }
  // Управляющий канал существует только шифрованным (SRV-3): `ws://` здесь —
  // не «тоже сойдёт», а признак того, что адрес не от нашего агента.
  if (parsed.protocol !== 'wss:') return undefined;
  return {
    url: parsed.origin,
    pairingCode: parsed.searchParams.get('code') ?? '',
    fingerprint: parsed.searchParams.get('fingerprint') ?? '',
  };
}

/** Мост контейнера — контракт `desktop-shell`, а не вторая его копия (DSK-2). */
export type ManagerBridge = DesktopBridge;

/**
 * Мост страницы, если он там есть. Признак десктопа — НАЛИЧИЕ моста, а не
 * строка user-agent и не флаг сборки (DSK-1): менеджер остаётся тем же
 * веб-приложением.
 */
export function managerBridge(scope: unknown): ManagerBridge | undefined {
  return desktopBridgeOf(scope);
}

/** Идентификатор сервиса агента в профиле менеджера (`apps/server-manager.app.json`). */
export const AGENT_SERVICE = 'agent';

/**
 * Поднять локального агента и получить его адрес (MGR-5). Отказ запуска —
 * ОТКАЗ, а не молчание: приложение, показавшее человеку кнопку, обязано уметь
 * сказать, почему сервиса нет (DSK-7).
 */
export async function startLocalAgent(bridge: ManagerBridge): Promise<LocalAgentAddress> {
  const start = bridge.startService;
  if (start === undefined || !bridge.session.services.includes(AGENT_SERVICE)) {
    throw new Error('профиль этой сессии сервиса агента не объявлял (DSK-5)');
  }
  const state = await start(AGENT_SERVICE);
  const parsed = parseLocalAgentAddress(state.address);
  if (parsed === undefined) {
    // Адрес НЕ ЦИТИРУЕТСЯ целиком: в нём материал автопейринга (`code`,
    // `fingerprint` — MGR-5), а это сообщение уходит в консоль страницы.
    // Называется схема и происхождение, а не секрет.
    throw new Error(
      `агент вернул адрес, который менеджер не понимает (ожидался wss:// с кодом и отпечатком), длиной ${String(state.address.length)}`,
    );
  }
  return parsed;
}
