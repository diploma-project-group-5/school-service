// Конфігурація і перевірка дзвінків без бази.
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';
import { checkBells } from '../src/domain/profile.js';
import { ProblemError } from '../src/problem.js';

const base = {
  DATABASE_URL: 'postgres://a',
  RELAY_DATABASE_URL: 'postgres://r',
  MAINT_DATABASE_URL: 'postgres://m',
  OIDC_ISSUER: 'http://localhost/idp/realms/lad',
  OIDC_JWKS_URL: 'http://localhost/idp/realms/lad/protocol/openid-connect/certs',
};

describe('конфігурація', () => {
  test('значення за замовчуванням', () => {
    expect(loadConfig(base)).toMatchObject({
      host: '0.0.0.0',
      port: 3002,
      internalPort: 3102,
      oidcClientId: 'web',
      kafkaBrokers: [],
      kafkaClientId: 'school-service',
      kafkaGroupId: 'school-service',
      relayIntervalMs: 500,
    });
  });

  test('список брокерів через кому', () => {
    expect(loadConfig({ ...base, KAFKA_BROKERS: ' kafka:9092, ,other:9092 ' }).kafkaBrokers).toEqual(['kafka:9092', 'other:9092']);
  });

  test('бракує змінних — помилка з переліком', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL, RELAY_DATABASE_URL, MAINT_DATABASE_URL, OIDC_ISSUER, OIDC_JWKS_URL/);
  });

  test('порт — додатне ціле; публічний і внутрішній порти різні', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: '0' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, PORT: '3000', INTERNAL_PORT: '3000' })).toThrow(/INTERNAL_PORT/);
  });
});

describe('дзвінки', () => {
  test('коректні дзвінки проходять, урок може починатися одразу після попереднього', () => {
    expect(() =>
      checkBells([
        { lesson_no: 2, start: '09:15', end: '10:00' },
        { lesson_no: 1, start: '08:30', end: '09:15' },
      ]),
    ).not.toThrow();
  });

  test('помилка — ProblemError 400', () => {
    try {
      checkBells([{ lesson_no: 1, start: '25:00', end: '26:00' }]);
      expect.fail('мало кинути');
    } catch (err) {
      expect(err).toBeInstanceOf(ProblemError);
      expect((err as ProblemError).problem).toMatchObject({ status: 400, code: 'validation_failed' });
    }
  });
});
