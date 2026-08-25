/**
 * Сертификат агента (SRV-3, решение D4): управляющий канал существует ТОЛЬКО в
 * шифрованном виде, незашифрованного варианта нет ни в какой конфигурации.
 *
 * Сертификат self-signed и генерируется при первом старте в каталог состояния;
 * при следующих стартах он ПЕРЕИСПОЛЬЗУЕТСЯ — иначе закреплённый клиентом
 * отпечаток (TOFU) менялся бы на каждый перезапуск агента, и «громкий отказ при
 * смене отпечатка» кричал бы на штатный рестарт, то есть перестал бы что-либо
 * значить.
 *
 * Генерация — малой зависимостью (`selfsigned`): правило «ноль рантайм-
 * зависимостей» касается ЯДРА (`engine/core-ts`), а агент — слой игры. Своя PKI
 * отвергнута дизайном: операционная цена без выигрыша для одного админа.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import selfsigned from 'selfsigned';
import { normalizeFingerprint } from '../protocol/fingerprint.js';
import type { AgentPaths } from './paths.js';

/** Срок сертификата: десять лет. Агент админа не должен «протухать» молча. */
const DAYS = 3650;

export interface AgentCertificate {
  readonly key: string;
  readonly cert: string;
  /**
   * Отпечаток SHA-256 сертификата в нижнем регистре без разделителей — ровно та
   * строка, которую закрепляет клиент (TOFU, SRV-3). Считается из DER, как её
   * считает и TLS-стек на другой стороне: два разных способа посчитать один
   * отпечаток — это способ им разойтись.
   */
  readonly fingerprint: string;
}

/** Отпечаток PEM-сертификата: SHA-256 его DER, нижний регистр, без двоеточий. */
export function fingerprintOf(pem: string): string {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
}

/** Приведение отпечатка к одной форме живёт в словаре протокола: его читают обе стороны. */
export { normalizeFingerprint };

/**
 * Сертификат агента: существующий с диска либо только что сгенерированный.
 *
 * Имя в сертификате нужно лишь формально: подлинность агента проверяется
 * ОТПЕЧАТКОМ (SRV-3), а не цепочкой доверия и не совпадением имени — цепочки у
 * self-signed нет по построению, и клиент это знает.
 */
export function ensureCertificate(paths: AgentPaths): AgentCertificate {
  if (existsSync(paths.keyFile) && existsSync(paths.certFile)) {
    const cert = readFileSync(paths.certFile, 'utf8');
    return {
      key: readFileSync(paths.keyFile, 'utf8'),
      cert,
      fingerprint: fingerprintOf(cert),
    };
  }
  const generated = selfsigned.generate([{ name: 'commonName', value: 'fluxus-server-agent' }], {
    days: DAYS,
    keySize: 2048,
    algorithm: 'sha256',
  });
  // Ключ пишется с правами «только владельцу»: он и есть подлинность агента.
  writeFileSync(paths.keyFile, generated.private, { mode: 0o600 });
  writeFileSync(paths.certFile, generated.cert, { mode: 0o600 });
  return {
    key: generated.private,
    cert: generated.cert,
    fingerprint: fingerprintOf(generated.cert),
  };
}
