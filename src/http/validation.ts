import type { z } from 'zod';
import { ValidationError } from '../shared/application/errors';

export function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError(
      'VALIDATION_ERROR',
      'request payload is invalid',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}
