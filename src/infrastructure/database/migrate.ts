import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './mikro-orm.config';

/** Usage: bun src/infrastructure/database/migrate.ts up|down */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering';
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl, dbPoolMax: 2 }));
  try {
    const migrator = orm.getMigrator();
    if (command === 'up') {
      const applied = await migrator.up();
      console.log(JSON.stringify({ level: 'info', message: 'migrations applied', migrations: applied.map((m) => m.name) }));
    } else if (command === 'down') {
      const reverted = await migrator.down({ to: 0 });
      console.log(JSON.stringify({ level: 'info', message: 'migrations reverted', migrations: reverted.map((m) => m.name) }));
    } else {
      throw new Error(`unknown command ${command} (expected up|down)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', message: 'migration failed', error: String(err) }));
  process.exit(1);
});
