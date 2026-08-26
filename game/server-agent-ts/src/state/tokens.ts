/**
 * Пейринг и токены агента (SRV-3, решение D4).
 *
 * Аутентификация клиента идёт ПЕЙРИНГОМ: агент по локальной команде предъявляет
 * короткоживущий код, клиент обменивает его на долгоживущий токен. Агент ведёт
 * перечень выданных токенов и умеет отозвать любой; отозванный перестаёт
 * действовать и для новых, и для СУЩЕСТВУЮЩИХ подключений — второе делает
 * управляющий сервер, закрывая живые каналы, а перечень держится здесь.
 *
 * Хранилище — файл каталога состояния, и читается он ПРИ КАЖДОЙ операции, а не
 * кэшируется в памяти. Причина конкретная: код пейринга выдаёт ЛОКАЛЬНАЯ команда
 * (`agent pair`), то есть ДРУГОЙ процесс, — закэшированный перечень не увидел бы
 * только что выданного кода, и пейринг не сработал бы ровно в том сценарии, ради
 * которого заведён.
 *
 * Секреты лежат в файле открытым текстом. Это осознанная цена: каталог состояния
 * принадлежит пользователю агента, и шифровать его от него самого нечем. Тот же
 * риск назван и на стороне менеджера (решение D11).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Срок жизни пейринг-кода: пять минут — «короткоживущий» из SRV-3. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * Сколько неверных попыток пейринга подряд запирают его (SRV-3). Порог, а не
 * запрет навсегда: отсчёт идёт в окне TTL кода и сам собой сбрасывается, а
 * успешный пейринг снимает его сразу.
 *
 * Заведён потому, что канал слушает наружу и `hello` можно слать без предела,
 * каждый — за одно TLS-рукопожатие. Шестизначного кода на такой перебор мало;
 * длина кода расширена ниже, а порог закрывает саму возможность молотить.
 */
export const MAX_PAIRING_FAILURES = 5;

/** Выданный токен: сам секрет, его короткий идентификатор и имя клиента. */
export interface IssuedToken {
  readonly id: string;
  readonly secret: string;
  readonly label: string;
  readonly issuedAt: number;
}

interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

interface TokenFile {
  tokens: IssuedToken[];
  codes: PairingCode[];
  /** Отметки неудачных попыток пейринга в окне TTL: по ним считается запирание. */
  failures: number[];
}

/**
 * Алфавит кода: Crockford base32 без похожих букв (I, L, O, U). Ровно 32 знака,
 * а `byte % 32` при 256 значениях байта равновероятен — смещения нет.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Код пейринга: десять знаков base32 (≈50 бит). Шести цифр на канал, слушающий
 * наружу, было мало (SRV-3); программному автопейрингу (MGR-5) длина не мешает,
 * а человек вводит его один раз.
 */
function newCode(): string {
  const bytes = randomBytes(10);
  let code = '';
  // `byte % 32` при 256 значениях байта попадает в [0, 31] всегда — индекс
  // валиден, но компилятор этого не знает, поэтому пустая строка на всякий.
  for (const byte of bytes) code += CODE_ALPHABET[byte % 32] ?? '';
  return code;
}

/** Сравнение секретов постоянным временем: подбор токена не должен ускоряться. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface TokenStore {
  /** Выдать пейринг-код (SRV-3): локальная команда предъявляет его человеку. */
  issueCode(now: number): string;
  /**
   * Заперт ли пейринг перебором (SRV-3): слишком много неверных попыток в окне.
   * Проверяется ДО `redeem`, чтобы запертый пейринг отказывал даже верному коду.
   */
  pairingLocked(now: number): boolean;
  /**
   * Обменять код на долгоживущий токен; `undefined` — код не подошёл. Неудача
   * записывается как попытка (`pairingLocked`); успех сбрасывает счётчик.
   */
  redeem(code: string, label: string, now: number): IssuedToken | undefined;
  /** Действителен ли токен: перечень читается с диска на каждый вызов. */
  valid(secret: string): boolean;
  /** Перечень выданных токенов БЕЗ секретов: наружу секрет уезжает один раз. */
  list(): readonly Omit<IssuedToken, 'secret'>[];
  /** Отозвать токен по идентификатору; `false` — такого токена нет. */
  revoke(id: string): boolean;
  /** Секрет токена по идентификатору — нужен серверу, чтобы закрыть живые каналы. */
  secretOf(id: string): string | undefined;
}

export function tokenStore(file: string): TokenStore {
  const read = (): TokenFile => {
    if (!existsSync(file)) return { tokens: [], codes: [], failures: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { tokens: [], codes: [], failures: [] };
      const source = parsed as Partial<TokenFile>;
      return {
        tokens: Array.isArray(source.tokens) ? source.tokens : [],
        codes: Array.isArray(source.codes) ? source.codes : [],
        failures: Array.isArray(source.failures) ? source.failures : [],
      };
    } catch {
      // Испорченный файл не роняет агента и не «чинится» молча в пользу
      // доступа: считаем, что выданных токенов нет, — тогда единственный путь
      // внутрь остаётся через пейринг у машины, а не мимо него.
      return { tokens: [], codes: [], failures: [] };
    }
  };

  /** Неудачные попытки в окне TTL кода: старше — уже не в счёт. */
  const recentFailures = (state: TokenFile, now: number): number[] =>
    state.failures.filter((at) => at > now - PAIRING_CODE_TTL_MS);

  const write = (state: TokenFile): void => {
    // Запись АТОМАРНАЯ: `writeFileSync` в целевой файл обрезает его первым делом,
    // и обрыв на середине (питание, SIGKILL) оставил бы половину JSON. Разбор
    // такого файла честно считает, что токенов нет, — то есть КАЖДЫЙ выданный
    // токен перестаёт работать разом, и вернуть управление можно только придя к
    // машине. Временный файл плюс `rename` делает смену одним шагом.
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    // Режим ПЕРЕВЫСТАВЛЯЕТСЯ: `mode` действует только при создании, и файл,
    // однажды оказавшийся доступным на чтение всем (восстановленный бэкап,
    // разложенный дистрибутив), так и оставался бы таким после каждой записи.
    try {
      chmodSync(file, 0o600);
    } catch {
      // Файловая система без прав POSIX (FAT на флешке, некоторые монтирования
      // Windows) — режим там не выражается вовсе, и это не повод падать.
    }
  };

  return {
    issueCode(now) {
      const state = read();
      const code = newCode();
      // Просроченные коды выметаются здесь же: файл не должен расти от того,
      // что кто-то нажал «пейринг» и передумал.
      state.codes = state.codes.filter((entry) => entry.expiresAt > now);
      // Выдача кода — ЛОКАЛЬНАЯ команда человека у машины (SRV-3), и она снимает
      // запирание перебором. Иначе сосед по сети, шлющий один неверный код в
      // минуту, запирал бы пейринг навсегда: существующие токены работают, но
      // добавить новый менеджер нельзя — отказ в самом обслуживании, которого
      // порог не имел в виду. Перебирать при этом по-прежнему бесполезно: сбросить
      // счётчик перебором нельзя, только доступом к самой машине.
      state.failures = [];
      state.codes.push({ code, expiresAt: now + PAIRING_CODE_TTL_MS });
      write(state);
      return code;
    },
    pairingLocked(now) {
      return recentFailures(read(), now).length >= MAX_PAIRING_FAILURES;
    },
    redeem(code, label, now) {
      const state = read();
      // Запертый перебором пейринг отказывает даже верному коду (SRV-3): иначе
      // порог не защищал бы — угадавший с (N+1)-й попытки всё равно прошёл бы.
      if (recentFailures(state, now).length >= MAX_PAIRING_FAILURES) return undefined;
      const live = state.codes.filter((entry) => entry.expiresAt > now);
      const match = live.find((entry) => sameSecret(entry.code, code));
      if (match === undefined) {
        // Неверный либо просроченный код — попытка перебора: записываем её и
        // заодно выметаем просроченные коды.
        state.codes = live;
        state.failures = [...recentFailures(state, now), now];
        write(state);
        return undefined;
      }
      // Код ОДНОРАЗОВЫЙ: обменянный код перестаёт действовать немедленно, иначе
      // подслушавший его получил бы второй токен на тех же основаниях.
      state.codes = live.filter((entry) => entry !== match);
      // Успешный пейринг снимает запирание: за пультом свой человек.
      state.failures = [];
      const token: IssuedToken = {
        id: randomBytes(6).toString('hex'),
        secret: randomBytes(32).toString('hex'),
        label: label === '' ? 'менеджер' : label,
        issuedAt: now,
      };
      state.tokens.push(token);
      write(state);
      return token;
    },
    valid(secret) {
      if (secret === '') return false;
      return read().tokens.some((entry) => sameSecret(entry.secret, secret));
    },
    list() {
      return read().tokens.map(({ id, label, issuedAt }) => ({ id, label, issuedAt }));
    },
    revoke(id) {
      const state = read();
      const rest = state.tokens.filter((entry) => entry.id !== id);
      if (rest.length === state.tokens.length) return false;
      state.tokens = rest;
      write(state);
      return true;
    },
    secretOf(id) {
      return read().tokens.find((entry) => entry.id === id)?.secret;
    },
  };
}
