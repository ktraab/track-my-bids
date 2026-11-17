import Database from '@tauri-apps/plugin-sql';
import type { Sql } from './sql';

export async function openTauriSql(): Promise<Sql> {
  const db = await Database.load('sqlite:trackmybids.db');
  await db.execute('PRAGMA journal_mode = WAL');
  await db.execute('PRAGMA foreign_keys = ON');
  return {
    async execute(query, params = []) {
      await db.execute(query, params);
    },
    select<T>(query: string, params: unknown[] = []) {
      return db.select<T[]>(query, params);
    },
  };
}
