import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createExtractLabelRepo } from './extractLabels';
import type { Sql } from './sql';

let sql: Sql;
let clockIso = '2026-11-19T10:00:00.000Z';
let repo: ReturnType<typeof createExtractLabelRepo>;

beforeEach(async () => {
  clockIso = '2026-11-19T10:00:00.000Z';
  sql = await memorySql();
  await migrate(sql);
  repo = createExtractLabelRepo(sql, () => clockIso, seqIds('lbl'));
});

describe('extract label repo', () => {
  it('records a new phrase normalized, then bumps its hits', async () => {
    await repo.recordLabel('due', '  Envelope   OPENING ');
    clockIso = '2026-11-20T10:00:00.000Z';
    await repo.recordLabel('due', 'envelope opening');
    expect(await repo.listLearned()).toEqual([
      { id: 'lbl-1', field: 'due', phrase: 'envelope opening', hits: 2, createdAt: '2026-11-19T10:00:00.000Z', updatedAt: '2026-11-20T10:00:00.000Z' },
    ]);
  });

  it('the same phrase under another field is a separate label; lists by field then hits', async () => {
    await repo.recordLabel('qa_deadline', 'last call');
    await repo.recordLabel('due', 'last call');
    await repo.recordLabel('due', 'final packets due');
    await repo.recordLabel('due', 'final packets due');
    expect((await repo.listLearned()).map((l) => [l.field, l.phrase, l.hits])).toEqual([
      ['due', 'final packets due', 2], ['due', 'last call', 1], ['qa_deadline', 'last call', 1],
    ]);
  });

  it('remove soft-deletes; learning it again revives the row with 1 hit', async () => {
    await repo.recordLabel('due', 'envelope opening');
    await repo.recordLabel('due', 'envelope opening');
    const [l] = await repo.listLearned();
    await repo.remove(l.id);
    expect(await repo.listLearned()).toEqual([]);
    const [row] = await sql.select<{ deleted_at: string | null }>('SELECT deleted_at FROM extract_labels WHERE id = ?', [l.id]);
    expect(row.deleted_at).toBe('2026-11-19T10:00:00.000Z');
    await repo.recordLabel('due', 'envelope opening');
    expect(await repo.listLearned()).toMatchObject([{ id: l.id, hits: 1 }]);
  });

  it('ignores blank input', async () => {
    await repo.recordLabel('due', '   ');
    await repo.recordLabel('', 'x y');
    expect(await repo.listLearned()).toEqual([]);
  });
});
