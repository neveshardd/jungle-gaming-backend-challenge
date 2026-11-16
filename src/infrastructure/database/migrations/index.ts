import { Migration20261116000000_initial_schema } from './Migration20261116000000_initial_schema';

/** Explicit, ordered migration list (no filesystem discovery: works the same under Bun, tests and Docker). */
export const MIGRATIONS = [
  { name: 'Migration20261116000000_initial_schema', class: Migration20261116000000_initial_schema },
];
