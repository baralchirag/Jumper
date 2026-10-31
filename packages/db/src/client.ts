import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL, opts: { max?: number } = {}): {
  db: Database;
  close: () => Promise<void>;
} {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), close: () => sql.end({ timeout: 5 }) };
}
