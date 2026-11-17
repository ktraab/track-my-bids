import { describe, it, expect, beforeEach } from 'vitest';
import { memorySql, fixedClock, seqIds } from './memorySql';
import { migrate } from './migrations';
import { createChecklistTemplateRepo } from './checklistTemplate';
import { createBidRepo } from './bids';
import { createBackupRepo } from './backup';
import { DEFAULT_TEMPLATE } from '../domain/checklist';
import type { Sql } from './sql';

let sql: Sql;
let repo: ReturnType<typeof createChecklistTemplateRepo>;

beforeEach(async () => {
  sql = await memorySql();
  await migrate(sql);
  repo = createChecklistTemplateRepo(sql, fixedClock(), seqIds('t'));
});

describe('checklist template repo', () => {
  it('defaults until saved', async () => {
    expect(await repo.load()).toEqual(DEFAULT_TEMPLATE);
  });
  it('saves, loads in order, and an empty save means no checklist', async () => {
    await repo.save([{ text: 'Pricing', appliesTo: 'all' }, { text: 'Courier', appliesTo: 'sealed' }]);
    expect(await repo.load()).toEqual([{ text: 'Pricing', appliesTo: 'all' }, { text: 'Courier', appliesTo: 'sealed' }]);
    await repo.save([]);
    expect(await repo.load()).toEqual([]);
    await repo.reset();
    expect(await repo.load()).toEqual(DEFAULT_TEMPLATE);
  });
  it('new bids use the saved template', async () => {
    await repo.save([{ text: 'Pricing', appliesTo: 'all' }, { text: 'Courier', appliesTo: 'sealed' }, { text: 'Upload', appliesTo: 'online' }]);
    const bids = createBidRepo(sql, fixedClock(), seqIds('b'), () => repo.load());
    await bids.create({ title: 'T', agencyName: 'A', agencyType: 'k12', submissionMethod: 'sealed', dueAtLocal: '2026-11-24T10:00', timezone: 'America/Chicago' });
    const [d] = await bids.listAll();
    expect(d.checklist.map((c) => c.text)).toEqual(['Pricing', 'Courier']);
  });
  it('reset after a customization loads the default; an empty save after reset stays empty', async () => {
    await repo.save([{ text: 'Pricing', appliesTo: 'all' }]);
    await repo.reset();
    expect(await repo.load()).toEqual(DEFAULT_TEMPLATE);
    await repo.save([]);
    expect(await repo.load()).toEqual([]);
    await repo.reset();
    expect(await repo.load()).toEqual(DEFAULT_TEMPLATE);
  });
});

describe('checklist template restore', () => {
  async function db(prefix: string) {
    const s = await memorySql();
    await migrate(s);
    let t = '2026-01-01T00:00:00.000Z';
    const r = createChecklistTemplateRepo(s, () => t, seqIds(prefix));
    return { sql: s, repo: r, at: (iso: string) => { t = iso; } };
  }

  it('a reset is not undone by restoring an older backup', async () => {
    const a = await db('a');
    a.at('2026-02-01T00:00:00.000Z');
    await a.repo.save([{ text: 'Old item', appliesTo: 'all' }]);
    const backup = await createBackupRepo(a.sql).exportAll('x');

    const b = await db('b');
    b.at('2026-03-01T00:00:00.000Z');
    await b.repo.save([{ text: 'Mine', appliesTo: 'all' }]);
    b.at('2026-04-01T00:00:00.000Z');
    await b.repo.reset();
    await createBackupRepo(b.sql).importAll(backup);
    expect(await b.repo.load()).toEqual(DEFAULT_TEMPLATE);
  });

  it('a newer backup template replaces the local one instead of merging', async () => {
    const b = await db('b');
    b.at('2026-02-01T00:00:00.000Z');
    await b.repo.save([{ text: 'Local', appliesTo: 'all' }]);

    const a = await db('a');
    a.at('2026-03-01T00:00:00.000Z');
    await a.repo.save([{ text: 'Remote 1', appliesTo: 'all' }, { text: 'Remote 2', appliesTo: 'sealed' }]);
    const backup = await createBackupRepo(a.sql).exportAll('x');

    await createBackupRepo(b.sql).importAll(backup);
    expect(await b.repo.load()).toEqual([{ text: 'Remote 1', appliesTo: 'all' }, { text: 'Remote 2', appliesTo: 'sealed' }]);
  });

  it('an older backup template is ignored entirely', async () => {
    const a = await db('a');
    a.at('2026-02-01T00:00:00.000Z');
    await a.repo.save([{ text: 'Remote', appliesTo: 'all' }]);
    const backup = await createBackupRepo(a.sql).exportAll('x');

    const b = await db('b');
    b.at('2026-03-01T00:00:00.000Z');
    await b.repo.save([{ text: 'Local', appliesTo: 'all' }]);
    await createBackupRepo(b.sql).importAll(backup);
    expect(await b.repo.load()).toEqual([{ text: 'Local', appliesTo: 'all' }]);
  });
});
