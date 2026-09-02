/**
 * Представление менеджера (`server-manager` MGR-2, MGR-3) — ЧИСТОЕ описание, а
 * не DOM.
 *
 * Так же, как в редакторе: область отдаёт узлы, а монтирует их отдельный слой
 * (`app/main.ts`). Причина та же — состояние проверяется тестом, а картинка
 * глазами: «игрок с запертым слотом остаётся в перечне со статусом `removed`, а
 * не пропадает» — это утверждение о ПРЕДСТАВЛЕНИИ, и держать его должен тест,
 * который не поднимает браузер.
 *
 * Действия названы строками (`action`): узел не носит обработчиков, поэтому
 * дерево сравнимо, а слой монтирования решает, что делать по имени.
 */
import type { ManagerState, ServerDetails, ServerRow } from './session.js';
import type { ServerEntry, SlotView } from '@fluxus/server-agent/protocol';
import { AUTO_RESTART_CHOICES, LAUNCH_FIELDS, ON_DISCONNECT_CHOICES } from './launch.js';

export interface UiNode {
  readonly tag: string;
  readonly cls?: string;
  readonly text?: string;
  /** Имя действия для слоя монтирования; отсутствует — узел не интерактивен. */
  readonly action?: string;
  /** Аргументы действия: хост, сервер, слот. */
  readonly args?: readonly string[];
  readonly disabled?: boolean;
  readonly value?: string;
  readonly children?: readonly UiNode[];
}

const node = (tag: string, cls: string, children: readonly UiNode[]): UiNode => ({ tag, cls, children });
const text = (tag: string, cls: string, value: string): UiNode => ({ tag, cls, text: value });

/** Человеческое имя статуса игрока (SRV-4): перечень закрыт, и перевод один. */
const STATUS_TEXT: Readonly<Record<string, string>> = {
  connecting: 'подключается',
  active: 'в бою',
  disconnected: 'разрыв',
  removed: 'убран',
  left: 'вышел',
  rejected: 'отказ',
};

/** Круг соединения либо названное его отсутствие (NTR-11): нулём не подменяем. */
function rttText(slot: SlotView): string {
  if (slot.rtt.kind === 'measured') return `${String(Math.round(slot.rtt.ms ?? 0))} мс`;
  return slot.rtt.kind === 'pending' ? '…' : '—';
}

function slotRow(details: ServerDetails, slot: SlotView, live: boolean): UiNode {
  const paused = details.entry.pause !== 'running';
  return node('div', `mg-slot mg-slot--${slot.status}`, [
    text('span', 'mg-slot__name', slot.playerId),
    text('span', 'mg-slot__status', STATUS_TEXT[slot.status] ?? slot.status),
    text('span', 'mg-slot__role', slot.role === 'substitute' ? 'заместитель' : ''),
    text('span', 'mg-slot__rtt', `пинг ${rttText(slot)}`),
    text(
      'span',
      'mg-slot__response',
      // Серверная половина отклика (NTR-11): полное «нажал → увидел» — величина
      // клиента, и админ-каналу она недоступна. Названо так, чтобы админ не
      // принял половину за целое и не недооценил задержку, которую чувствует игрок.
      `отклик сервера ${slot.serverResponseMs === null ? '—' : `${String(slot.serverResponseMs)} мс`}`,
    ),
    text(
      'span',
      'mg-slot__snapshots',
      // Размер снапшотов соединения и снапшоты, НЕ ушедшие из-за его очереди
      // отправки (NTR-22). Стоят рядом намеренно: порог пропуска назван в
      // снапшотах, и вторая цифра без первой не читается. Вместе с пингом и
      // длительностью тика это третий ответ на «дорога, сервер или канал»
      // (NTR-11): растущее «пропущено» при здоровых первых двух — узкий канал.
      `снапшоты ${(slot.snapshotBytes / 1024).toFixed(1)} КиБ · пропущено ${String(slot.snapshotsSkipped)}`,
    ),
    {
      tag: 'button',
      cls: 'mg-action',
      text: 'дисконект',
      action: 'disconnect-player',
      args: [details.host, details.entry.id, String(slot.slot)],
      // Отвязывать нечего у слота без живого соединения — и кнопка это
      // показывает недоступностью, а не отказом после нажатия. У сервера без
      // живого процесса недоступны и все остальные админ-операции (SRV-5).
      disabled: !live || (slot.status !== 'active' && slot.status !== 'connecting'),
    },
    {
      tag: 'button',
      cls: 'mg-action',
      // «Убрать» и «вернуть» — это запирание слота и его снятие (NTR-19).
      text: slot.status === 'removed' ? 'вернуть' : 'убрать',
      action: slot.status === 'removed' ? 'unbar-slot' : 'bar-slot',
      args: [details.host, details.entry.id, String(slot.slot)],
      disabled: !live || (paused && slot.status !== 'removed'),
    },
  ]);
}

function metricsRow(details: ServerDetails): UiNode {
  const metrics = details.metrics;
  if (metrics === null) {
    // Метрик нет, пока подписка не принесла отчёта (решение D9): «—» честнее
    // нулей, которых никто не мерил.
    return text('div', 'mg-metrics', 'счётчики: —');
  }
  return text(
    'div',
    'mg-metrics',
    `тик p99 ${metrics.tickP99Ms.toFixed(2)} мс · рассылка p99 ${metrics.broadcastP99Ms.toFixed(2)} мс · ` +
      `снапшотов ${String(metrics.snapshotsSent)} · ${(metrics.bytesSent / 1024).toFixed(1)} КиБ · ` +
      `цикл событий ${metrics.eventLoopDelayMs.toFixed(2)} мс · RSS ${(metrics.rssBytes / 1048576).toFixed(0)} МиБ`,
  );
}

/**
 * Разбор ушедшего процесса (SRV-6): код выхода и путь к сохранённым материалам —
 * то, с чего начинается утро после ночного краша. Оба поля приезжают записью
 * реестра, и не показать их значило бы отправить человека искать каталог разбора
 * руками по диску.
 *
 * Сорвавшееся сохранение НАЗЫВАЕТСЯ здесь же, а не подменяется прочерком:
 * «материалов нет» и «сохранить их не удалось» — разные новости (SRV-6).
 */
function postmortemRow(entry: ServerEntry): UiNode {
  const materials =
    entry.postmortemFailure !== null
      ? `материалы разбора не сохранены: ${entry.postmortemFailure}`
      : entry.postmortem === null
        ? 'материалов разбора нет'
        : `материалы разбора: ${entry.postmortem}`;
  return text(
    'div',
    'mg-details__postmortem',
    `код выхода: ${entry.exitCode === null ? '—' : String(entry.exitCode)} · ${materials}`,
  );
}

/** Окно деталей сервера (MGR-3). */
function detailsPanel(details: ServerDetails): UiNode {
  const entry = details.entry;
  const frozen = entry.pause !== 'running';
  // Админ-операции идут через ЖИВОЙ сервер матча (SRV-5): у процесса, которого
  // агент не достаёт, кнопки недоступны, а не отказывают после нажатия. Сами
  // детали при этом открыты — ради них в упавший сервер и кликают (SRV-6).
  //
  // Признак — ПАРА, а не одно состояние процесса: отказ `not-running` у агента
  // два производителя. Второй — сервер, переживший прежнего агента: его запись
  // числится `listening`, потому что порт он и вправду держит, но stdio ушло
  // вместе с прежним процессом, и до него не доходит ни одна админ-операция
  // («доступны только реестр и остановка»). Именно это и означает непустой
  // `limited`: подписка отказала — живого процесса у агента нет.
  const live =
    details.limited === '' && (entry.state === 'listening' || entry.state === 'starting');
  // Материалы разбора — про УШЕДШИЙ процесс, и ключ у них свой: у пережившего
  // прежнего агента сервера процесс жив, выхода не было, и строка «код выхода: —»
  // сообщала бы о крахе, которого не случилось (SRV-6).
  const exited = entry.state === 'crashed' || entry.state === 'stopped';
  return node('section', 'mg-details', [
    text('h2', 'mg-details__title', `${entry.id} · ${entry.match}`),
    text(
      'div',
      'mg-details__state',
      `процесс: ${entry.state} · матч: ${entry.phase ?? '—'} · рестартов: ${String(entry.restarts)}` +
        // Состояние паузы ВИДНО в деталях сервера (MGR-3).
        (frozen ? ` · пауза: ${entry.pause ?? ''}` : ''),
    ),
    // Материалы разбора показываются РОВНО у того сервера, чей процесс ушёл.
    ...(exited ? [postmortemRow(entry)] : []),
    // Названная причина неполноты деталей (SRV-2): подписки на процесс, которого
    // нет, не бывает, и человек видит, почему в окне нет счётчиков.
    ...(details.limited === ''
      ? []
      : [text('div', 'mg-details__limited', `детали ограничены: ${details.limited}`)]),
    {
      tag: 'button',
      cls: 'mg-action mg-action--primary',
      text: frozen ? 'возобновить' : 'пауза',
      action: frozen ? 'resume' : 'pause',
      args: [details.host, entry.id],
      disabled: !live,
    },
    metricsRow(details),
    node('div', 'mg-slots', entry.slots.map((slot) => slotRow(details, slot, live))),
    text('h3', 'mg-details__logTitle', 'хвост лога'),
    node(
      'pre',
      'mg-log',
      details.log.map((line) => text('code', 'mg-log__line', line)),
    ),
  ]);
}

/**
 * Строка общего списка серверов (MGR-2). Выбранный опознаётся ПАРОЙ «хост +
 * идентификатор»: идентификаторы реестра (`srv-1`, `srv-2`…) нумеруются внутри
 * агента, и у двух хостов они совпадают — по голому идентификатору подсветились
 * бы обе строки сразу, и человек не понял бы, чей сервер в деталях.
 */
function serverRow(row: ServerRow, selected: ServerDetails | undefined): UiNode {
  const entry = row.entry;
  const busy = entry.slots.filter((slot) => slot.status === 'active').length;
  const picked = selected?.host === row.host && selected.entry.id === entry.id;
  return node('div', `mg-server${picked ? ' mg-server--selected' : ''}`, [
    {
      tag: 'button',
      cls: 'mg-server__pick',
      text: `${row.hostLabel} · ${entry.id}`,
      action: 'select',
      args: [row.host, entry.id],
    },
    text('span', 'mg-server__state', entry.state),
    text('span', 'mg-server__phase', entry.phase ?? '—'),
    // Счётчик рестартов перечислен в ОБЩЕМ списке (MGR-2), а не только в
    // деталях: круги матча — то, по чему сервер, отыгравший ночь подряд,
    // отличается от только что поднятого, и ради этого не должно быть клика.
    text('span', 'mg-server__restarts', `рестартов: ${String(entry.restarts)}`),
    text('span', 'mg-server__slots', `${String(busy)}/${String(entry.slots.length)}`),
    text('span', 'mg-server__address', entry.address),
    {
      // Ссылка входа игрока (SRV-8, MGR-2): её копируют и отдают тестеру.
      tag: 'button',
      cls: 'mg-action',
      text: 'ссылка входа',
      action: 'copy-join',
      args: [entry.joinUrl],
      disabled: entry.joinUrl === '',
    },
    {
      tag: 'button',
      cls: 'mg-action',
      text: 'остановить',
      action: 'stop',
      args: [row.host, entry.id],
    },
  ]);
}

function hostsPanel(state: ManagerState): UiNode {
  return node('section', 'mg-hosts', [
    text('h2', 'mg-hosts__title', 'хосты'),
    ...state.hosts.map((host) =>
      node('div', `mg-host${host.connected ? ' mg-host--live' : ''}`, [
        text('span', 'mg-host__label', host.label),
        text('span', 'mg-host__url', host.url),
        text('span', 'mg-host__version', host.connected ? `${host.buildId} + ${host.contentPackHash}` : ''),
        // Идущая попытка НАЗВАНА: строка хоста появляется сразу по нажатию
        // (MGR-1), и без этого слова она молчала бы ровно так же, как строка
        // хоста, подключение к которому не начиналось.
        text('span', 'mg-host__state', host.connecting ? 'подключается…' : ''),
        text('span', 'mg-host__failure', host.failure),
        {
          tag: 'button',
          cls: 'mg-action',
          text: 'забыть',
          action: 'forget-host',
          args: [host.id],
          // Локальный хост поднят объявленным сервисом (MGR-5) — забывать нечего.
          disabled: host.local,
        },
      ]),
    ),
    node('div', 'mg-hosts__add', [
      { tag: 'input', cls: 'mg-input', value: 'wss://', action: 'host-url' },
      { tag: 'input', cls: 'mg-input', value: '', action: 'host-code' },
      { tag: 'button', cls: 'mg-action mg-action--primary', text: 'добавить хост', action: 'add-host' },
    ]),
  ]);
}

/** Поле формы: подпись рядом с полем — иначе шесть полей неразличимы (MGR-2). */
const field = (label: string, control: UiNode): UiNode =>
  node('label', 'mg-field', [text('span', 'mg-field__label', label), control]);

/** Выпадающий список из перечня «значение — подпись». */
const choice = (
  action: string,
  value: string,
  options: readonly { readonly value: string; readonly label: string }[],
): UiNode => ({
  tag: 'select',
  cls: 'mg-input',
  action,
  value,
  children: options.map((option) => ({ tag: 'option', text: option.label, value: option.value })),
});

/**
 * Форма запуска (MGR-2): «запустить сервер с параметрами запуска (SRV-2)» — а
 * SRV-2 называет эти параметры поимённо, и все шесть обязаны быть в форме.
 * Подставленная константа вместо поля — это параметр, которого у админа нет:
 * выключить авто-рестарт или назвать политику разрыва ему было бы нечем.
 */
function launchPanel(state: ManagerState): UiNode {
  const connected = state.hosts.filter((host) => host.connected);
  return node('section', 'mg-launch', [
    text('h2', 'mg-launch__title', 'запустить сервер'),
    field('хост', {
      // ЦЕЛЕВОЙ хост запуска (MGR-2): без выбора форма молча целилась бы в
      // первый попавшийся, а список документов принадлежал бы другому хосту.
      tag: 'select',
      cls: 'mg-input',
      action: LAUNCH_FIELDS.host,
      value: state.launchHost,
      children: connected.map((host) => ({
        tag: 'option',
        text: host.local ? `${host.label} (локальный)` : host.label,
        value: host.id,
      })),
    }),
    field('документ матча', {
      tag: 'select',
      cls: 'mg-input',
      action: LAUNCH_FIELDS.match,
      // Умолчание НАЗВАНО, а не подразумевается: `<select>` без значения
      // показывал бы первый документ, а запуск без выбора уходил бы со своим
      // собственным умолчанием — форма обещала бы не то, что запускает (MGR-2).
      value: state.matches[0] ?? '',
      // Документы матча — из перечня ЦЕЛЕВОГО хоста (решение D11): дерева
      // контента у профиля менеджера нет вовсе, список приходит от его агента.
      children: state.matches.map((match) => ({ tag: 'option', text: match, value: match })),
    }),
    field('порт (0 — авто)', { tag: 'input', cls: 'mg-input', value: '0', action: LAUNCH_FIELDS.port }),
    // Профиль бота — ПУТЬ внутри дерева контента, и вводится он строкой, а не
    // выбирается списком: перечня профилей у протокола нет (агент перечисляет
    // только документы матча, решение D11), а заводить его ради необязательного
    // параметра значило бы менять протокол мимоходом. Пустая строка — умолчание
    // стенда; путь мимо дерева контента агент отвергает названной причиной
    // (`unknown-match`), и отказ доезжает до человека как всякий другой (SRV-2).
    field('профиль бота', { tag: 'input', cls: 'mg-input', value: '', action: LAUNCH_FIELDS.bot }),
    field('дедлайн бот-заполнителя, мс', {
      tag: 'input',
      cls: 'mg-input',
      value: '',
      action: LAUNCH_FIELDS.botFill,
    }),
    field('политика разрыва', choice(LAUNCH_FIELDS.onDisconnect, '', ON_DISCONNECT_CHOICES)),
    field('авто-рестарт', choice(LAUNCH_FIELDS.autoRestart, 'yes', AUTO_RESTART_CHOICES)),
    { tag: 'button', cls: 'mg-action mg-action--primary', text: 'запустить', action: 'start' },
  ]);
}

/** Всё окно менеджера одним описанием. */
export function managerView(state: ManagerState): UiNode {
  const selected = state.details;
  return node('div', 'mg-app', [
    node('header', 'mg-top', [
      text('h1', 'mg-top__title', 'Fluxus Server Manager'),
      {
        // Тумблер «остановить серверы при выходе» (MGR-4), умолчание — включён.
        tag: 'button',
        cls: `mg-toggle${state.killOnExit ? ' mg-toggle--on' : ''}`,
        text: `остановить серверы при выходе: ${state.killOnExit ? 'да' : 'нет'}`,
        action: 'toggle-kill-on-exit',
      },
    ]),
    hostsPanel(state),
    launchPanel(state),
    node('section', 'mg-servers', [
      text('h2', 'mg-servers__title', 'серверы'),
      ...state.servers.map((row) => serverRow(row, selected)),
    ]),
    ...(state.details === undefined ? [] : [detailsPanel(state.details)]),
    // Названная причина отказа — то, что менеджер обязан показать вместо
    // «сервер не появился» (MGR-2).
    ...(state.notice === '' ? [] : [text('div', 'mg-notice', state.notice)]),
  ]);
}

/** Плоский обход дерева: тестам и слою монтирования нужен один и тот же. */
export function walk(root: UiNode): UiNode[] {
  const out: UiNode[] = [root];
  for (const child of root.children ?? []) out.push(...walk(child));
  return out;
}
