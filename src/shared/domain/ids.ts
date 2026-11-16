import { uuidv7 } from 'uuidv7';

export interface IdGenerator {
  next(): string;
}

/** UUIDv7: time-ordered, index friendly, globally unique without coordination. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
