import type { ContactInput } from '../domain/contacts';
import type { ImportPlan } from '../domain/importClassify';
import type { Sql } from './sql';
import type { createBidRepo } from './bids';
import type { createMilestoneRepo } from './milestones';
import type { createContactRepo } from './contacts';

type Repos = {
  bids: ReturnType<typeof createBidRepo>;
  milestones: ReturnType<typeof createMilestoneRepo>;
  contacts: ReturnType<typeof createContactRepo>;
};

export async function importedUids(sql: Sql): Promise<Set<string>> {
  const rows = await sql.select<{ external_uid: string }>(
    'SELECT external_uid FROM milestones WHERE external_uid IS NOT NULL AND deleted_at IS NULL');
  return new Set(rows.map((r) => r.external_uid));
}

const nameKey = (c: { firstName?: string | null; lastName?: string | null; organization?: string | null }) =>
  [c.firstName, c.lastName, c.organization].map((x) => (x ?? '').trim().toLowerCase()).join('|');

/**
 * Add contacts, matching existing ones by email (in the repo) or — for rows
 * without an email — by first + last name + organization, so a re-import
 * doesn't duplicate them. The first three error messages are returned.
 */
export async function importContacts(repos: Repos, inputs: ContactInput[]) {
  const r = { added: 0, matched: 0, failed: 0, errors: [] as string[] };
  const known = new Set((await repos.contacts.list()).map((x) => nameKey(x.contact)));
  for (const c of inputs) {
    const noEmail = !(c.email ?? '').trim();
    try {
      if (noEmail && known.has(nameKey(c))) { r.matched++; continue; }
      const { existing } = await repos.contacts.create(c);
      existing ? r.matched++ : r.added++;
      if (noEmail) known.add(nameKey(c));
    } catch (e) {
      r.failed++;
      if (r.errors.length < 3) {
        const who = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Contact';
        r.errors.push(`${who}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return r;
}

export async function runImportPlan(repos: Repos, plan: ImportPlan) {
  const r = { bids: 0, milestones: 0, failed: [] as string[] };
  for (const nb of plan.newBids) {
    try {
      const dueLocal = nb.dueIso.slice(0, 16); // ISO is already in nb.timezone
      const bidId = await repos.bids.create({
        title: nb.title, agencyName: nb.agencyName, agencyType: nb.agencyType, submissionMethod: nb.method,
        dueAtLocal: dueLocal, timezone: nb.timezone, dueExternalUid: nb.dueUid,
      });
      r.bids++;
      for (const m of nb.milestones) {
        await repos.milestones.add({ bidId, type: m.type, label: m.label, at: m.iso, mandatory: m.mandatory, location: m.location, externalUid: m.uid });
        r.milestones++;
      }
    } catch (e) {
      r.failed.push(`${nb.agencyName}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const quoteIds = plan.existing.length
    ? new Set((await repos.bids.listAll()).filter((d) => d.bid.kind === 'rfq').map((d) => d.bid.id)) : new Set<string>();
  for (const ex of plan.existing) {
    if (quoteIds.has(ex.bidId)) {
      if (ex.milestones.length) r.failed.push("Skipped: quotes don't have milestones — convert it to a bid first.");
      continue;
    }
    for (const m of ex.milestones) {
      try {
        if (m.type === 'due') {
          r.failed.push(`${m.label ?? 'Due date'}: this bid already has a due date — change it on the bid instead.`);
          continue;
        }
        await repos.milestones.add({ bidId: ex.bidId, type: m.type, label: m.label, at: m.iso, mandatory: m.mandatory, location: m.location, externalUid: m.uid });
        r.milestones++;
      } catch (e) {
        r.failed.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return r;
}
