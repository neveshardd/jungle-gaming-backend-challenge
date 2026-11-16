import type { Knex } from '@mikro-orm/postgresql';

/**
 * Thin parameterized SQL executor over the knex connection/transaction owned by MikroORM.
 * Placeholders are `?` (knex). Arrays are sent as native PostgreSQL arrays: use `= ANY(?::type[])`, never `IN (?)`.
 * `undefined` is normalized to NULL.
 */
export class SqlExecutor {
  constructor(private readonly connection: Knex | Knex.Transaction) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const result = (await this.connection.raw(sql, normalize(params))) as { rows?: T[] };
    return result.rows ?? [];
  }

  async one<T>(sql: string, params: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  /** Returns the number of affected rows. */
  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    const result = (await this.connection.raw(sql, normalize(params))) as { rowCount?: number | null };
    return result.rowCount ?? 0;
  }
}

function normalize(params: readonly unknown[]): Knex.RawBinding[] {
  return params.map((p) => (p === undefined ? null : p)) as Knex.RawBinding[];
}

/**
 * MikroORM registers pg type parsers that return timestamp columns as strings.
 * Mappers normalize every timestamp through these helpers.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toOptionalDate(value: Date | string | null | undefined): Date | undefined {
  return value === null || value === undefined ? undefined : toDate(value);
}
