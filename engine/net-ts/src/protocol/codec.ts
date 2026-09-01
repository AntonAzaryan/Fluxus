/**
 * Кодирование кадра (NTR-13). Формат подменяется реализацией `Serializer`
 * ядра (SER-2), а не полем в сообщении: участники матча исполняют одну версию
 * (NET-16), поэтому формат — свойство сборки, и поле «каким форматом говорим»
 * дало бы способ рассогласоваться там, где рассогласоваться нечему.
 *
 * MessagePack — рантайм-поток, JSON — дебаг-режим; оба разрешены SER-3 для
 * своих ролей, и оба ходят через один интерфейс.
 */
import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';
import { jsonSerializer, type Serializer } from '@fluxus/core';
import {
  parseClientMessage,
  parseServerMessage,
  ProtocolError,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

/**
 * Порядок ключей сериализатор НЕ задаёт (SER-2): он получает готовую
 * plain-форму и кодирует её как есть. Прежний `sortKeys: true` эту норму
 * нарушал, и не безобидно: верхний уровень плоской формы мира несёт поля в
 * порядке SER-1 (`toPlain`), а не по алфавиту, и на провод форма уезжает
 * целиком (`WireSnapshot.world`), — то есть сортировка переставляла именно
 * тот уровень, которому SER-1 и SER-6 переставляться прямо запрещают. Карты
 * имён данных внутри формы (компоненты, их поля, теги) приезжают
 * отсортированными от самого ядра, и держать их порядок кодеку не нужно.
 *
 * `ignoreUndefined` — чтобы отсутствующее необязательное поле было отсутствующим,
 * а не `nil`: разбор на той стороне различает эти случаи по-разному. Отбором
 * данных (SER-2) это не является: то же самое делает `JSON.stringify` в
 * дебаг-формате, и без него два формата разошлись бы в том, что доезжает.
 *
 * Поле эпохи (NTR-16) едет обоими форматами как обычное целое верхнего уровня
 * сообщения и собственной раскладки не требует: порядок полей конверта
 * нормой не является вовсе (SER-6), а обязательность поля держит разбор.
 */
export const msgpackSerializer: Serializer = {
  name: 'msgpack',
  encode: (value) => msgpackEncode(value, { ignoreUndefined: true }),
  decode: (bytes) => msgpackDecode(bytes),
};

export { jsonSerializer };

export const DEFAULT_SERIALIZER: Serializer = msgpackSerializer;

/** Кодек одной стороны: кодирует свои сообщения, разбирает чужие. */
export interface Codec<TOut, TIn> {
  readonly serializer: Serializer;
  encode(message: TOut): Uint8Array;
  decode(bytes: Uint8Array): TIn;
}

function decodeWith<T>(
  serializer: Serializer,
  bytes: Uint8Array,
  parse: (value: unknown) => T,
): T {
  let raw: unknown;
  try {
    raw = serializer.decode(bytes);
  } catch (error) {
    // Битые байты и валидное-но-чужое сообщение дают один исход: соединение
    // рвётся с названной причиной (NTR-4). Разделять их незачем — чинится и то,
    // и другое одинаково, обновлением до общей версии.
    throw new ProtocolError(`кадр не разбирается сериализатором ${serializer.name}: ${String(error)}`);
  }
  return parse(raw);
}

/** Кодек серверной стороны: наружу уходят `ServerMessage`, внутрь приходят `ClientMessage`. */
export function serverCodec(serializer: Serializer = DEFAULT_SERIALIZER): Codec<ServerMessage, ClientMessage> {
  return {
    serializer,
    encode: (message) => serializer.encode(message),
    decode: (bytes) => decodeWith(serializer, bytes, parseClientMessage),
  };
}

/** Кодек клиентской стороны — зеркало серверного. */
export function clientCodec(serializer: Serializer = DEFAULT_SERIALIZER): Codec<ClientMessage, ServerMessage> {
  return {
    serializer,
    encode: (message) => serializer.encode(message),
    decode: (bytes) => decodeWith(serializer, bytes, parseServerMessage),
  };
}
