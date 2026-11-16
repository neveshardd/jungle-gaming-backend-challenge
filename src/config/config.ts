import { hostname } from 'node:os';
import { z } from 'zod';

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(fallback)
    .transform((v) => v === 'true' || v === '1');
const int = (fallback: number, min = 0) => z.coerce.number().int().min(min).default(fallback);

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  PORT: int(3000),
  INSTANCE_ID: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().default('postgres://wagering:wagering@localhost:5432/wagering'),
  DB_POOL_MAX: int(20, 1),
  DB_LOCK_TIMEOUT_MS: int(5000, 1),
  DB_STATEMENT_TIMEOUT_MS: int(15000, 1),
  DB_TX_MAX_RETRIES: int(3),

  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().default('http://localhost:4566'),
  AWS_ACCESS_KEY_ID: z.string().default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().default('test'),
  SQS_AUTO_CREATE: bool('true'),
  SQS_INPUT_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wallet-events.fifo'),
  SQS_CONSUMER_NAME: z.string().default('wager-transactions-consumer'),
  SQS_CONSUMER_CONCURRENCY: int(2, 1),
  SQS_BATCH_SIZE: int(10, 1),
  SQS_WAIT_TIME_SECONDS: int(10),
  SQS_VISIBILITY_TIMEOUT_SECONDS: int(30, 1),
  SQS_MAX_ATTEMPTS: int(5, 1),
  SQS_RETRY_BASE_SECONDS: int(2),
  SQS_RETRY_MAX_SECONDS: int(60),

  OUTBOX_POLL_INTERVAL_MS: int(500, 10),
  OUTBOX_BATCH_SIZE: int(50, 1),
  OUTBOX_LEASE_MS: int(30000, 100),
  OUTBOX_RETRY_BASE_MS: int(1000, 1),
  OUTBOX_RETRY_MAX_MS: int(300000, 1),

  PENDING_REF_POLL_INTERVAL_MS: int(1000, 10),
  PENDING_REF_BATCH_SIZE: int(50, 1),
  PENDING_REF_MAX_ATTEMPTS: int(10, 1),
  PENDING_REF_BASE_DELAY_MS: int(2000, 1),
  PENDING_REF_MAX_DELAY_MS: int(300000, 1),

  SHUTDOWN_GRACE_MS: int(20000),

  OTEL_ENABLED: bool('false'),
  OTEL_SERVICE_NAME: z.string().default('wagering-processor'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),

  FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK: bool('false'),
});

export type AppRole = 'api' | 'worker' | 'all';

export interface AppConfig {
  env: string;
  role: AppRole;
  port: number;
  instanceId: string;
  logLevel: string;
  database: {
    url: string;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    maxRetries: number;
  };
  aws: { region: string; endpoint: string; accessKeyId: string; secretAccessKey: string };
  sqs: {
    autoCreate: boolean;
    inputQueue: string;
    deadLetterQueue: string;
    eventsQueue: string;
    consumerName: string;
    concurrency: number;
    batchSize: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    maxAttempts: number;
    retryBaseSeconds: number;
    retryMaxSeconds: number;
  };
  outbox: { pollIntervalMs: number; batchSize: number; leaseMs: number; retryBaseMs: number; retryMaxMs: number };
  pendingReference: { pollIntervalMs: number; batchSize: number; maxAttempts: number; baseDelayMs: number; maxDelayMs: number };
  shutdownGraceMs: number;
  tracing: { enabled: boolean; serviceName: string; otlpEndpoint: string };
  faults: { crashAfterCommitBeforeAck: boolean };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  return {
    env: c.NODE_ENV,
    role: c.APP_ROLE,
    port: c.PORT,
    instanceId: c.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    logLevel: c.LOG_LEVEL,
    database: {
      url: c.DATABASE_URL,
      poolMax: c.DB_POOL_MAX,
      lockTimeoutMs: c.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: c.DB_STATEMENT_TIMEOUT_MS,
      maxRetries: c.DB_TX_MAX_RETRIES,
    },
    aws: {
      region: c.AWS_REGION,
      endpoint: c.AWS_ENDPOINT_URL,
      accessKeyId: c.AWS_ACCESS_KEY_ID,
      secretAccessKey: c.AWS_SECRET_ACCESS_KEY,
    },
    sqs: {
      autoCreate: c.SQS_AUTO_CREATE,
      inputQueue: c.SQS_INPUT_QUEUE,
      deadLetterQueue: c.SQS_DLQ,
      eventsQueue: c.SQS_EVENTS_QUEUE,
      consumerName: c.SQS_CONSUMER_NAME,
      concurrency: c.SQS_CONSUMER_CONCURRENCY,
      batchSize: Math.min(c.SQS_BATCH_SIZE, 10),
      waitTimeSeconds: Math.min(c.SQS_WAIT_TIME_SECONDS, 20),
      visibilityTimeoutSeconds: c.SQS_VISIBILITY_TIMEOUT_SECONDS,
      maxAttempts: c.SQS_MAX_ATTEMPTS,
      retryBaseSeconds: c.SQS_RETRY_BASE_SECONDS,
      retryMaxSeconds: c.SQS_RETRY_MAX_SECONDS,
    },
    outbox: {
      pollIntervalMs: c.OUTBOX_POLL_INTERVAL_MS,
      batchSize: c.OUTBOX_BATCH_SIZE,
      leaseMs: c.OUTBOX_LEASE_MS,
      retryBaseMs: c.OUTBOX_RETRY_BASE_MS,
      retryMaxMs: c.OUTBOX_RETRY_MAX_MS,
    },
    pendingReference: {
      pollIntervalMs: c.PENDING_REF_POLL_INTERVAL_MS,
      batchSize: c.PENDING_REF_BATCH_SIZE,
      maxAttempts: c.PENDING_REF_MAX_ATTEMPTS,
      baseDelayMs: c.PENDING_REF_BASE_DELAY_MS,
      maxDelayMs: c.PENDING_REF_MAX_DELAY_MS,
    },
    shutdownGraceMs: c.SHUTDOWN_GRACE_MS,
    tracing: {
      enabled: c.OTEL_ENABLED,
      serviceName: c.OTEL_SERVICE_NAME,
      otlpEndpoint: c.OTEL_EXPORTER_OTLP_ENDPOINT,
    },
    // Fault injection is only honoured in test mode, never in production.
    faults: { crashAfterCommitBeforeAck: c.NODE_ENV === 'test' && c.FAULT_CRASH_AFTER_COMMIT_BEFORE_ACK },
  };
}
