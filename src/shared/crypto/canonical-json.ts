import { createHash } from 'node:crypto';

/**
 * Canonical JSON (RFC 8785-like subset):
 *  - object keys sorted lexicographically by UTF-16 code units (Array.prototype.sort default),
 *    recursively;
 *  - properties whose value is `undefined` are omitted;
 *  - no insignificant whitespace;
 *  - strings/booleans/null serialized with JSON.stringify;
 *  - non-finite numbers and bigint are rejected (monetary values are strings anyway).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonical JSON does not support values of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
