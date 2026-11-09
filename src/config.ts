// Конфігурація зі змінних середовища. Обов'язкові змінні перевіряються при старті:
// сервіс не запускається з неповним .env і називає, чого бракує.

export interface Config {
  host: string;
  /** Публічний порт: шлюз веде сюди /api/v1/school/*. */
  port: number;
  /** Окремий порт для /internal/v1/*: шлюз на нього не веде (розділ 07). */
  internalPort: number;
  logLevel: string;
  /** Робоча роль school_app: лише DML, без BYPASSRLS. */
  databaseUrl: string;
  /** Роль school_relay: лише outbox (другий пул у процесі сервісу). */
  relayDatabaseUrl: string;
  /** Роль school_maint: чистка журналу, outbox та inbox (третій пул). */
  maintDatabaseUrl: string;
  oidcIssuer: string;
  oidcJwksUrl: string;
  oidcClientId: string;
  /** Порожній рядок — Kafka вимкнено (наприклад, локальна розробка лише HTTP). */
  kafkaBrokers: string[];
  kafkaClientId: string;
  kafkaGroupId: string;
  /** Пауза між проходами relay, мс. */
  relayIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} має бути додатним цілим числом, отримано: ${raw}`);
    return n;
  };

  const config: Config = {
    host: env.HOST ?? '0.0.0.0',
    port: int('PORT', 3002),
    internalPort: int('INTERNAL_PORT', 3102),
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: required('DATABASE_URL'),
    relayDatabaseUrl: required('RELAY_DATABASE_URL'),
    maintDatabaseUrl: required('MAINT_DATABASE_URL'),
    oidcIssuer: required('OIDC_ISSUER'),
    oidcJwksUrl: required('OIDC_JWKS_URL'),
    oidcClientId: env.OIDC_CLIENT_ID ?? 'web',
    kafkaBrokers: (env.KAFKA_BROKERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? 'school-service',
    kafkaGroupId: env.KAFKA_GROUP_ID ?? 'school-service',
    relayIntervalMs: int('RELAY_INTERVAL_MS', 500),
  };

  if (missing.length > 0) {
    throw new Error(`Не задано змінні середовища: ${missing.join(', ')} (див. .env.example)`);
  }
  if (config.port === config.internalPort) {
    throw new Error('PORT і INTERNAL_PORT мають відрізнятися: внутрішні маршрути не можна відкривати шлюзу');
  }
  return config;
}
