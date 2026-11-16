import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { currentContext } from '../observability/context';
import type { Logger } from '../shared/application/logger';
import { mapError } from './error-mapping';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);
    if (mapped.status >= 500 && mapped.status !== 503) {
      this.logger.error({ err: exception, code: mapped.body.code }, 'request failed');
    } else {
      this.logger.warn({ code: mapped.body.code, status: mapped.status }, 'request rejected');
    }
    if (mapped.retryAfterSeconds !== undefined) response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    response.status(mapped.status).json({ ...mapped.body, correlationId: currentContext().correlationId });
  }
}
