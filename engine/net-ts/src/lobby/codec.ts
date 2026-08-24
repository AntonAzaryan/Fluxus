/**
 * Кодек лобби. Формат кадра тот же, что у матча (NTR-13), — свойство сборки, а
 * не поле в сообщении; различается только набор сообщений (`net-session` SES-4).
 */
import type { Serializer } from '@fluxus/core';
import { DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import {
  LobbyProtocolError,
  parseLobbyClientMessage,
  parseLobbyServerMessage,
  type LobbyClientMessage,
  type LobbyServerMessage,
} from './messages.js';

function decodeWith<T>(serializer: Serializer, bytes: Uint8Array, parse: (value: unknown) => T): T {
  let raw: unknown;
  try {
    raw = serializer.decode(bytes);
  } catch (error) {
    throw new LobbyProtocolError(`кадр лобби не разбирается сериализатором ${serializer.name}: ${String(error)}`);
  }
  return parse(raw);
}

export function lobbyServerCodec(
  serializer: Serializer = DEFAULT_SERIALIZER,
): Codec<LobbyServerMessage, LobbyClientMessage> {
  return {
    serializer,
    encode: (message) => serializer.encode(message),
    decode: (bytes) => decodeWith(serializer, bytes, parseLobbyClientMessage),
  };
}

export function lobbyClientCodec(
  serializer: Serializer = DEFAULT_SERIALIZER,
): Codec<LobbyClientMessage, LobbyServerMessage> {
  return {
    serializer,
    encode: (message) => serializer.encode(message),
    decode: (bytes) => decodeWith(serializer, bytes, parseLobbyServerMessage),
  };
}
