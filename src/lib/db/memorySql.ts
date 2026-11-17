import initSqlJs from 'sql.js';
import type { Sql } from './sql';

export async function memorySql(): Promise<Sql> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  return {
    async execute(query, params = []) {
      if (params.length === 0) db.exec(query); // runs every statement in the string
      else db.run(query, params as any[]);
    },
    async select<T>(query: string, params: unknown[] = []) {
      const stmt = db.prepare(query);
      stmt.bind(params as any[]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
  };
}

export function fixedClock(iso = '2026-11-16T13:42:00.000Z') {
  return () => iso;
}

export function seqIds(prefix = 'id') {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
