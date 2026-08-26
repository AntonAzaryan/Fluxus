/**
 * Счёт отпечатка предъявленного сертификата (DSK-8, решение D4).
 *
 * Проверяется то единственное, ради чего функция существует: контейнер и
 * сервис, пишущий закрепление, считают ОДНО И ТО ЖЕ число. Импортировать
 * `fingerprintOf` агента для этого нельзя — контейнер не зависит от пакетов игры
 * (DSK-3), — поэтому обе стороны сверяются с третьей, независимой от них обеих:
 * `X509Certificate.fingerprint256` самого Node, который считает отпечаток
 * разбором сертификата, а не разбором PEM-обёртки. Со стороны агента то же
 * утверждение держит его собственный тест сертификата (SRV-3).
 *
 * Фикстура — committed self-signed сертификат (`fixtures/pinned.cert.pem`),
 * тот же, которым прогон вне гейта поднимает шифрованный сервис-пустышку.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { certificateFingerprint, isFingerprint } from '../src/host/certificate.js';
import { PINNED_CERTIFICATE, PINNED_FINGERPRINT } from './support.js';

describe('отпечаток сертификата: PEM → SHA-256 DER hex (DSK-8, решение D4)', () => {
  it('считается тем же способом, каким его считает сам сервис', () => {
    const pem = readFileSync(PINNED_CERTIFICATE, 'utf8');
    // Разбор сертификата самим Node — независимый счёт того же отпечатка:
    // совпав с ним, наш счёт совпадает и с тем, который агент пишет в
    // закрепление (`fingerprintOf`, SRV-3).
    const byNode = new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
    expect(certificateFingerprint(pem)).toBe(byNode);
    // И то же значение записано в тесте буквально: разъехавшись с фикстурой,
    // прогон вне гейта (`contract:electron`) краснел бы «сертификат не
    // закреплён», не называя причины.
    expect(certificateFingerprint(pem)).toBe(PINNED_FINGERPRINT);
    expect(isFingerprint(certificateFingerprint(pem))).toBe(true);
  });

  it('цепочка закрепляется листом, а не склейкой: считается ПЕРВЫЙ блок', () => {
    const pem = readFileSync(PINNED_CERTIFICATE, 'utf8');
    // Склеенный DER двух блоков не является сертификатом ни одной из сторон:
    // его отпечаток не совпал бы ни с чем и превратил бы сверку в вечный отказ.
    expect(certificateFingerprint(`${pem}\n${pem}`)).toBe(PINNED_FINGERPRINT);
  });

  it('не сертификат — пустой ответ, а не выдуманное число', () => {
    // Пустая строка безопасна по построению: закреплений пустыми не бывает, и
    // нераспознанный PEM поэтому не совпадёт ни с одним из них.
    expect(certificateFingerprint('')).toBe('');
    expect(certificateFingerprint('совсем не сертификат')).toBe('');
    expect(certificateFingerprint('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n')).toBe('');
    // Приватный ключ — тоже не сертификат: блок называется иначе.
    expect(certificateFingerprint('-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----')).toBe('');
  });

  it('форма закрепления — ровно 64 hex-знака нижнего регистра (решение D1)', () => {
    expect(isFingerprint('a'.repeat(64))).toBe(true);
    expect(isFingerprint(PINNED_FINGERPRINT.toUpperCase())).toBe(false);
    expect(isFingerprint(PINNED_FINGERPRINT.slice(0, 63))).toBe(false);
    expect(isFingerprint(`${PINNED_FINGERPRINT}0`)).toBe(false);
    // Отпечаток с двоеточиями — форма openssl, а не форма закрепления: принимать
    // обе значило бы иметь два вида одного файла.
    expect(isFingerprint('e8:9a:5a:a6')).toBe(false);
    expect(isFingerprint('')).toBe(false);
  });
});
