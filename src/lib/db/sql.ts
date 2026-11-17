export type Row = Record<string, any>;

/** Minimal SQL surface. Use `?` placeholders only. One statement per call. */
export interface Sql {
  execute(query: string, params?: unknown[]): Promise<void>;
  select<T = Row>(query: string, params?: unknown[]): Promise<T[]>;
}
