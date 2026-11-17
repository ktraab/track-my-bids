const TS = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const ACTIVE = '(SELECT recording FROM sync_flags WHERE id = 1) = 1 AND (SELECT applying FROM sync_flags WHERE id = 1) = 0';
const UPSERT = 'ON CONFLICT(tbl, row_id, field) DO UPDATE SET changed_at = excluded.changed_at';

/** Statements that (re)create the insert/update outbox triggers for one table. */
export function syncTriggerSql(tbl: string, cols: readonly string[]): string[] {
  const ins = cols
    .map((c) => `INSERT INTO sync_outbox (tbl, row_id, field, changed_at) SELECT '${tbl}', NEW.id, '${c}', ${TS} WHERE 1 ${UPSERT};`)
    .join('\n');
  const upd = cols
    .map((c) => `INSERT INTO sync_outbox (tbl, row_id, field, changed_at) SELECT '${tbl}', NEW.id, '${c}', ${TS} WHERE OLD.${c} IS NOT NEW.${c} ${UPSERT};`)
    .join('\n');
  return [
    `DROP TRIGGER IF EXISTS sync_ins_${tbl}`,
    `DROP TRIGGER IF EXISTS sync_upd_${tbl}`,
    `CREATE TRIGGER sync_ins_${tbl} AFTER INSERT ON ${tbl} WHEN ${ACTIVE}\nBEGIN\n${ins}\nEND`,
    `CREATE TRIGGER sync_upd_${tbl} AFTER UPDATE ON ${tbl} WHEN ${ACTIVE}\nBEGIN\n${upd}\nEND`,
  ];
}
