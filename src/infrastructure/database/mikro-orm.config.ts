import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { MIGRATIONS } from './migrations';

export interface OrmSettings {
  databaseUrl: string;
  dbPoolMax: number;
}

/**
 * MikroORM owns the connection pool, transactions (`em.transactional` with explicit
 * isolation level) and versioned, reversible migrations. The hot path uses explicit SQL
 * through the transaction's knex handle (see ARCHITECTURE.md for the rationale).
 */
export function buildOrmConfig(settings: OrmSettings) {
  return defineConfig({
    clientUrl: settings.databaseUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: settings.dbPoolMax },
    allowGlobalContext: true,
    debug: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      silent: true,
    },
  });
}
