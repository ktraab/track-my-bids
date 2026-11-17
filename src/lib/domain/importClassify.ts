import { DateTime } from 'luxon';
import type { AgencyType, BidWithChildren, Method, MilestoneType } from './types';
import type { ImportItem } from './importParse';
import { isOnNetwork } from './stages';
import { localToIso } from './time';

const DAY_MS = 86_400_000;

const RULES: [MilestoneType, RegExp][] = [
  ['qa_deadline', /\bq\s*&\s*a\b|\bquestions?\b|\binquir(y|ies)\b|\bclarification/i],
  ['site_walk', /\bsite\s*(walk|visit|tour)\b|\bwalk[\s-]?through\b/i],
  ['pre_bid', /\bpre[\s-]?(bid|proposal|submission)\b|\b(bidders?|vendor)\s*conference\b/i],
  ['addenda', /\baddend(a|um)\b/i],
  ['award', /\baward\b|\bboard\s*(meeting|approval|vote)\b|\bintent to award\b/i],
  ['due', /\bdue\b|\bdeadline\b|\bsubmi(t|ssion)\b|\bclos(e|es|ing)\b|\bbid opening\b|\bopening\b/i],
];

export function classify(title: string, description: string | null = null): { type: MilestoneType; mandatory: boolean } {
  const text = `${title} ${description ?? ''}`;
  const type = RULES.find(([, re]) => re.test(title))?.[0] ?? RULES.find(([, re]) => re.test(text))?.[0] ?? 'custom';
  return { type, mandatory: /\bmandatory\b|\brequired attendance\b/i.test(text) };
}

const NOISE = /\b(rfp|rfq|rfi|ifb|itb|itn|bid|bids|proposal|due|deadline|submission|submit|meeting|mandatory|pre[\s-]?bid|pre[\s-]?proposal|q\s*&\s*a|questions?|site|walk|visit|tour|walkthrough|addend(a|um)|award|opening|board|vote|expected|reminder|conference|closes?|closing)\b/gi;

/** The title with milestone words, ids and punctuation removed, original casing kept. */
function keyWords(title: string): string {
  return title
    .replace(/&/g, ' & ')
    .replace(NOISE, ' ')
    .replace(/\b[a-z]*\d[\w-]*\b/gi, ' ') // ids like 2026-31, #12
    .replace(/[^a-z\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function bidKey(title: string): string {
  return keyWords(title).toLowerCase();
}

/** "Austin ISD" stays as typed; all-lowercase words get a capital (except "of", "and", "the" mid-name). */
const labelCase = (s: string) =>
  s.replace(/\b[a-z]+\b/g, (w, at: number) => (at > 0 && /^(of|and|the)$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export type GroupTarget = { kind: 'new' } | { kind: 'existing'; bidId: string } | { kind: 'skip' };

export interface ImportRow {
  item: ImportItem;
  include: boolean;
  type: MilestoneType;
  mandatory: boolean;
}

export interface ImportGroup {
  key: string;
  label: string;
  target: GroupTarget;
  /** datetime-local value for a due date typed in by hand ('' = none); used when no row is the due date. */
  newBid: { title: string; agencyName: string; agencyType: AgencyType; method: Method; dueLocal: string };
  rows: ImportRow[];
}

const STOPWORDS = new Set(['the', 'of', 'and']);
const tokens = (s: string) => s.split(' ').filter((w) => w && !STOPWORDS.has(w));

/**
 * The existing bid whose agency matches a group key: the normalized agency
 * equals the key, or they share at least two words. Agencies shorter than 4
 * characters never match. Open bids win over closed ones; newest first.
 */
function matchExisting(key: string, bids: BidWithChildren[]): string | null {
  const keyTokens = new Set(tokens(key));
  const matches = bids.filter((d) => {
    const a = norm(d.bid.agencyName);
    if (a.length < 4) return false;
    if (a === key) return true;
    return tokens(a).filter((t) => keyTokens.has(t)).length >= 2;
  });
  const newest = (xs: BidWithChildren[]) => [...xs].sort((x, y) => y.bid.createdAt.localeCompare(x.bid.createdAt))[0];
  const open = matches.filter((d) => isOnNetwork(d.bid.stage));
  return (newest(open) ?? newest(matches))?.bid.id ?? null;
}

export function suggestGroups(items: ImportItem[], bids: BidWithChildren[], nowMs: number, imported: Set<string>): ImportGroup[] {
  const groups = new Map<string, ImportGroup>();
  for (const it of items) {
    if (imported.has(it.uid)) continue;
    const key = bidKey(it.title) || norm(it.title) || 'untitled';
    let g = groups.get(key);
    if (!g) {
      const existing = matchExisting(key, bids);
      const label = labelCase(keyWords(it.title)) || labelCase(key);
      g = {
        key, label,
        target: existing ? { kind: 'existing', bidId: existing } : { kind: 'new' },
        newBid: { title: it.title, agencyName: label, agencyType: 'other', method: 'online', dueLocal: '' },
        rows: [],
      };
      groups.set(key, g);
    }
    const c = classify(it.title, it.description);
    // An existing bid already has its due date; don't overwrite it by default.
    const include = it.startMs >= nowMs - 30 * DAY_MS && !(c.type === 'due' && g.target.kind === 'existing');
    g.rows.push({ item: it, include, type: c.type, mandatory: c.mandatory });
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.item.startMs - b.item.startMs);
    const dueRow = g.rows.find((r) => r.type === 'due');
    if (dueRow) g.newBid.title = dueRow.item.title;
    // Full-calendar exports: a group with no due date and no matching bid is
    // probably not a bid at all. Skip it unless the user opts in.
    if (!dueRow && g.target.kind === 'new') {
      g.target = { kind: 'skip' };
      if (g.rows.every((r) => r.type === 'custom')) g.rows.forEach((r) => (r.include = false));
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export interface PlannedMilestone {
  uid: string;
  type: MilestoneType;
  label: string | null;
  iso: string;
  mandatory: boolean;
  location: string | null;
  allDay: boolean;
}

export interface ImportPlan {
  newBids: (ImportGroup['newBid'] & { timezone: string; dueUid: string | null; dueIso: string; milestones: PlannedMilestone[] })[];
  existing: { bidId: string; milestones: PlannedMilestone[] }[];
  errors: string[];
}

function toMilestone(r: ImportRow, zone: string): PlannedMilestone {
  return {
    uid: r.item.uid,
    type: r.type,
    label: r.type === 'custom' ? r.item.title.slice(0, 80) : null,
    iso: DateTime.fromMillis(r.item.startMs, { zone }).toISO()!,
    mandatory: r.mandatory,
    location: r.item.location,
    allDay: r.item.allDay,
  };
}

export function buildImportPlan(groups: ImportGroup[], zone: string): ImportPlan {
  const plan: ImportPlan = { newBids: [], existing: [], errors: [] };
  for (const g of groups) {
    const rows = g.rows.filter((r) => r.include);
    if (g.target.kind === 'skip') continue;
    // An existing bid with nothing checked has nothing to add. A NEW bid is still created from a
    // typed due date even when no event is checked (or reported as an error if there is none).
    if (!rows.length && g.target.kind === 'existing') continue;
    const ms = rows.map((r) => toMilestone(r, zone));
    if (g.target.kind === 'existing') {
      // The bid already has a due date (changed on the bid itself), so due rows are dropped.
      const keep = ms.filter((m) => m.type !== 'due');
      if (keep.length) plan.existing.push({ bidId: g.target.bidId, milestones: keep });
      continue;
    }
    const dues = ms.filter((m) => m.type === 'due');
    if (dues.length > 1) {
      plan.errors.push(`${g.label}: only one event can be the due date.`);
      continue;
    }
    let due: { uid: string | null; iso: string };
    if (dues.length === 1) {
      due = { uid: dues[0].uid, iso: dues[0].iso };
    } else if (g.newBid.dueLocal.trim()) {
      try {
        due = { uid: null, iso: localToIso(g.newBid.dueLocal.trim(), zone) };
      } catch {
        plan.errors.push(`${g.label}: the due date looks wrong.`);
        continue;
      }
    } else {
      plan.errors.push(`${g.label}: enter a due date or mark one event as the due date (or skip this group).`);
      continue;
    }
    if (!g.newBid.title.trim() || !g.newBid.agencyName.trim()) {
      plan.errors.push(`${g.label}: title and agency are required.`);
      continue;
    }
    plan.newBids.push({
      ...g.newBid, timezone: zone, dueUid: due.uid, dueIso: due.iso,
      milestones: ms.filter((m) => m.type !== 'due'),
    });
  }
  return plan;
}
