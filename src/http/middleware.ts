import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { currentContext, runWithContext } from '../observability/context';
import type { Logger } from '../shared/application/logger';

const CORRELATION_ID = /^[\w.:-]{1,128}$/;
const QUIET_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

/** Correlation id (X-Correlation-Id in/out) + one structured access log line per request. */
export function correlationMiddleware(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && CORRELATION_ID.test(header) ? header : randomUUID();
    res.setHeader('X-Correlation-Id', correlationId);
    const startedAt = performance.now();
    runWithContext({ correlationId }, () => {
      res.on('finish', () => {
        const line = {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        };
        if (QUIET_PATHS.has(req.path)) logger.debug(line, 'http request');
        else logger.info(line, 'http request');
      });
      next();
    });
  };
}

const jsonParser = express.json({ limit: '64kb', strict: true });

/** JSON body parsing with a normalized 400 for malformed bodies. */
export function jsonBodyMiddleware(req: Request, res: Response, next: NextFunction): void {
  jsonParser(req, res, (err?: unknown) => {
    if (err) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'request body is not valid JSON',
        correlationId: currentContext().correlationId,
      });
      return;
    }
    next();
  });
}
