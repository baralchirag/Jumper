import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

/**
 * Where the SQL migrations live. Bundling changes `import.meta.url`, so look in every layout we ship:
 * source (`packages/db/src`), Docker (`/app/drizzle` beside `/app/dist`) and a monorepo build (apps/api/dist, apps/worker/dist).
 * `MIGRATIONS_DIR` overrides all of them.
 */
export function migrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    fileURLToPath(new URL('../drizzle', import.meta.url)),
    fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url)),
    fileURLToPath(new URL('./drizzle', import.meta.url)),
  ].filter((x): x is string => Boolean(x));
  const found = candidates.find((dir) => existsSync(`${dir}/meta/_journal.json`));
  if (!found) throw new Error(`Cannot find the database migrations. Looked in:\n  ${candidates.join('\n  ')}\nSet MIGRATIONS_DIR.`);
  return found;
}

export async function runMigrations(url = process.env.DATABASE_URL): Promise<void> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: migrationsFolder() });
  } finally {
    await close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => console.log('migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
