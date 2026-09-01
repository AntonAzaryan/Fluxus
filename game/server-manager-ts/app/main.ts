/**
 * Монтирование менеджера в страницу: состояние из `src/`, DOM здесь.
 *
 * Разделение то же, что у редактора (`editor-ui`): описание представления
 * проверяется тестом, а этот файл переводит его в узлы документа и связывает
 * действия с сессией. Ни одной проверки требований здесь нет — только перевод.
 *
 * Локальный агент поднимается ОБЪЯВЛЕННЫМ сервисом контейнера (MGR-5): адрес и
 * код автопейринга приезжают строкой от него. Без контейнера (обычная вкладка
 * браузера) локального агента нет — и это честно показано, а не подменено
 * зашитым адресом.
 */
import {
  createManagerSession,
  managerBridge,
  managerView,
  pageStorage,
  parseLocalAgentAddress,
  startLocalAgent,
  startParamsOf,
  walk,
  AGENT_SERVICE,
  LAUNCH_FIELDS,
  MANAGER_STYLES,
  type ManagerSession,
  type UiNode,
} from '../src/index.js';
import { browserSocket } from '@fluxus/server-agent/client';

function managerRoot(): HTMLElement {
  const element = document.getElementById('manager-root');
  if (element === null) throw new Error('в документе нет корня приложения');
  return element;
}

const root = managerRoot();

const style = document.createElement('style');
style.textContent = MANAGER_STYLES;
document.head.append(style);

const session: ManagerSession = createManagerSession({
  connect: browserSocket,
  storage: pageStorage(globalThis),
});

/** Поля формы: их значения живут в DOM, а не в состоянии сессии. */
const fields = new Map<string, string>();

function apply(action: string, args: readonly string[]): void {
  const [first = '', second = '', third = ''] = args;
  switch (action) {
    case 'add-host': {
      const code = fields.get('host-code') ?? '';
      // Код пейринга ОДНОРАЗОВЫЙ (SRV-3): оставить его в поле значило бы держать
      // на экране секрет, которым больше нельзя воспользоваться.
      fields.delete('host-code');
      void session.addRemote(fields.get('host-url') ?? '', code, '');
      return;
    }
    case 'forget-host':
      void session.forget(first);
      return;
    case LAUNCH_FIELDS.host:
      // Смена цели запуска: список документов принадлежит хосту, поэтому выбор
      // хоста обновляет и его (MGR-2). Запомненный документ ПРЕЖНЕГО хоста при
      // этом снимается: на новом его может не быть вовсе, и запуск ушёл бы с
      // именем, которого принимающий агент не знает, — обещанный отказ.
      fields.delete(LAUNCH_FIELDS.match);
      session.setLaunchHost(fields.get(LAUNCH_FIELDS.host) ?? first);
      return;
    case 'start': {
      // Цель запуска — ВЫБРАННЫЙ хост, а не первый попавшийся (MGR-2).
      const target = session.state.launchHost;
      if (target === '') return;
      // Все шесть параметров запуска (SRV-2) приезжают из ФОРМЫ: перевод полей
      // в параметры живёт в `src/launch.ts` и проверяется тестом — здесь только
      // передача, как и во всём этом файле.
      const form = startParamsOf(fields, session.state.matches[0] ?? '');
      // Форма, из которой параметров не собрать, — названный отказ, а не кнопка,
      // молча ничего не делающая, и не подставленное за человека умолчание.
      if (form.params === undefined) {
        session.refuse(form.failure);
        return;
      }
      void session.start(target, form.params);
      return;
    }
    case 'stop':
      void session.stop(first, second);
      return;
    case 'select':
      void session.select(first, second);
      return;
    case 'copy-join':
      void navigator.clipboard.writeText(first);
      return;
    case 'toggle-kill-on-exit':
      session.setKillOnExit(!session.state.killOnExit);
      return;
    case 'disconnect-player':
    case 'bar-slot':
    case 'unbar-slot':
      void session.admin(first, second, action, Number(third));
      return;
    case 'pause':
    case 'resume':
      void session.admin(first, second, action);
      return;
    default:
      return;
  }
}

function build(node: UiNode): Node {
  const element = document.createElement(node.tag);
  if (node.cls !== undefined) element.className = node.cls;
  if (node.text !== undefined) element.textContent = node.text;
  if (node.disabled === true) element.setAttribute('disabled', 'disabled');
  const isField = node.tag === 'input' || node.tag === 'select';
  if (isField) {
    const field = element as HTMLInputElement;
    const name = node.action ?? '';
    const onEdit = (): void => {
      fields.set(name, field.value);
      // Выбор целевого хоста — не просто хранимое поле: он меняет список
      // документов, поэтому обновляет состояние сессии и перерисовку (MGR-2).
      if (name === LAUNCH_FIELDS.host) apply(LAUNCH_FIELDS.host, [field.value]);
    };
    field.addEventListener('input', onEdit);
    field.addEventListener('change', onEdit);
  } else if (node.action !== undefined) {
    // Имя действия кладётся в локальную константу ДО обработчика: сужение типа
    // внутрь замыкания не проходит, а действие узла к моменту клика неизменно.
    const action = node.action;
    element.addEventListener('click', () => { apply(action, node.args ?? []); });
  }
  if (node.tag === 'option') element.setAttribute('value', node.value ?? node.text ?? '');
  for (const child of node.children ?? []) element.append(build(child));
  // Значение поля выставляется ПОСЛЕ добавления `<option>`: у `<select>`,
  // получившего value до своих опций, браузер молча выбирает первую — и
  // выпадающий список хоста запуска врал бы, показывая не ту цель (MGR-2).
  if (isField) {
    const field = element as HTMLInputElement;
    const name = node.action ?? '';
    field.value = fields.get(name) ?? node.value ?? '';
    // Значение, которому не нашлось `<option>`, браузер не выбирает никак
    // (`selectedIndex === -1`): список выглядел бы пустым, а запуск шёл бы с
    // запомненным именем чужого хоста. Возвращаемся к первому документу и
    // запоминаем ИМЕННО ЕГО — показанное и отправляемое должны совпасть (MGR-2).
    if (node.tag === 'select' && (element as HTMLSelectElement).selectedIndex < 0) {
      (element as HTMLSelectElement).selectedIndex = 0;
      if (field.value !== '') fields.set(name, field.value);
    }
  }
  return element;
}

/**
 * Действия, которые знает `apply`. Список, а не проверка на пустую строку:
 * кнопка с действием, которого нет в `switch`, молча ничего не делает — и
 * именно этот случай надо ловить, а пустого действия ни один узел не отдаёт.
 */
const KNOWN_ACTIONS = new Set([
  'add-host',
  'forget-host',
  LAUNCH_FIELDS.host,
  'start',
  'stop',
  'select',
  'copy-join',
  'toggle-kill-on-exit',
  'disconnect-player',
  'bar-slot',
  'unbar-slot',
  'pause',
  'resume',
]);

function draw(): void {
  const view = managerView(session.state);
  root.replaceChildren(build(view));
  // Названные действия обязаны существовать в переводе: узел с действием,
  // которого не знает `apply`, был бы кнопкой, ничего не делающей.
  for (const item of walk(view)) {
    if (item.tag === 'button' && item.action !== undefined && !KNOWN_ACTIONS.has(item.action)) {
      throw new Error(`кнопка с неизвестным действием "${item.action}"`);
    }
  }
}

session.onChange(draw);
draw();

// Локальный агент: адрес и код автопейринга — от объявленного сервиса (MGR-5).
const bridge = managerBridge(globalThis);
if (bridge?.session.services.includes(AGENT_SERVICE) === true) {
  void startLocalAgent(bridge)
    .then((local) => session.addLocal(local.url, local.pairingCode, local.fingerprint))
    .catch((error: unknown) => {
      // Отказ запуска — отказ, а не молчание (DSK-7): человеку показывают
      // причину, а не отсутствие хоста.
      console.error(`локальный агент не поднялся: ${String(error)}`);
    });
}
void session.restore();

// Политика завершения (MGR-4): при включённом тумблере закрытие останавливает
// серверы локального агента и сам агент. Контейнер о тумблере не знает — он
// исполняет явную остановку сервиса, как всякую другую (решение D6).
//
// Основной путь — запрос закрытия контейнера (DSK-2): в отличие от
// `beforeunload`, он УМЕЕТ ждать — контейнер держит окно открытым до ответа
// страницы (с крайним сроком на его стороне). Порядок здесь и есть лекарство от
// гонки: сперва `stop-all` кадром по управляющему каналу, затем явная остановка
// сервиса, и только потом согласие на закрытие — сигнал не может унести агента
// вместе с недоставленным `stop-all`.
const closeHook = bridge?.onCloseRequest;
if (closeHook !== undefined) {
  closeHook(async () => {
    if (session.state.killOnExit) {
      await session.closing();
      // Отказ остановки не держит окно: агент мог уже уйти сам, а закрытие
      // менеджера — не место для отказов (тот же выбор, что в `closing()`).
      await bridge?.stopService?.(AGENT_SERVICE).catch(() => undefined);
    }
    return true;
  });
} else {
  // Обычная вкладка браузера: контейнерного запроса закрытия нет, остаётся
  // `beforeunload` — он ждать не умеет, и `stop-all` уходит best-effort.
  // Останавливать здесь нечего, кроме серверов: сервиса агента без моста нет.
  globalThis.addEventListener('beforeunload', () => {
    if (!session.state.killOnExit) return;
    void session.closing();
  });
}

// Ссылка входа игрока приезжает от агента (SRV-8): дублировать её разбором
// параметров страницы менеджеру незачем — он не игрок.
export const managerSession = session;
export { parseLocalAgentAddress };
