import type { LoggerService } from '@nestjs/common';
import pino from 'pino';
import type { Logger } from '../shared/application/logger';
import { currentContext } from './context';

export interface LoggerSettings {
  level: string;
  service: string;
  instanceId: string;
}

/**
 * JSON logs (pino) enriched with correlationId / messageId / transactionId / walletId /
 * providerId from the async context. Monetary fields and payloads are redacted defensively,
 * even though the code never logs them on purpose.
 */
export function createLogger(settings: LoggerSettings): Logger {
  const logger = pino({
    level: settings.level,
    base: { service: settings.service, instanceId: settings.instanceId },
    messageKey: 'message',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
    mixin: () => ({ ...currentContext() }),
    redact: {
      paths: [
        'money',
        'balance',
        'amount',
        'payload',
        'body',
        'data',
        '*.money',
        '*.balance',
        '*.amount',
        '*.payload',
        '*.body',
        'req.headers.authorization',
      ],
      censor: '[REDACTED]',
    },
  });
  return logger as unknown as Logger;
}

/** Routes NestJS framework logs through the structured logger. */
export class NestLoggerAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
}
