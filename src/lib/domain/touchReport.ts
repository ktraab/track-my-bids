import { DateTime } from 'luxon';
import type { AgencyType, BidKind, BidWithChildren, Stage, TouchKind, TouchSource } from './types';
import { rangeFor, type CsvColumn, type ReportFilters } from './report';
import { stageLabel } from './stages';
import { TOUCH_KIND_LABELS, touchWho } from './touches';

/** One logged touch, for the Touches export (spec §4). */
export interface TouchReportRow {
  touchId: string;
  bidId: string;
  agencyName: string;
  agencyType: AgencyType;
  bidTitle: string;
  kind: BidKind;
  stage: Stage;
  touchKind: TouchKind;
  source: TouchSource;
  who: string | null;
  note: string | null;
  at: string;
  author: string | null;
  bidTimezone: string;
}

export interface TouchReportOptions {
  /** Quote totals (as for the contacts report): a quote is valued by its total, else its estimate. */
  ourPrice?: ReadonlyMap<string, number>;
  contactNames?: ReadonlyMap<string, string>;
  /** Team member id → name; null author (Local mode) is left blank. */
  authorName?: (id: string) => string;
}

/**
 * Every live touch on bids matching the report filters: date range applies to the touch's own time; stages,
 * agency types and value bounds apply to its bid (contact roles don't apply to touches). Newest first.
 */
export function touchReportRows(
  bids: BidWithChildren[], f: ReportFilters, nowMs: number, zone: string, opts: TouchReportOptions = {},
): TouchReportRow[] {
  const range = rangeFor(f, nowMs, zone);
  const out: TouchReportRow[] = [];
  for (const d of bids) {
    const b = d.bid;
    if (b.deletedAt) continue;
    if (f.stages.length && !f.stages.includes(b.stage)) continue;
    if (f.agencyTypes.length && !f.agencyTypes.includes(b.agencyType)) continue;
    const value = b.kind === 'rfq' ? opts.ourPrice?.get(b.id) ?? b.estValue : b.estValue;
    if ((f.minValue != null || f.maxValue != null) && value == null) continue;
    if (f.minValue != null && value! < f.minValue) continue;
    if (f.maxValue != null && value! > f.maxValue) continue;
    for (const t of d.touches) {
      if (t.deletedAt) continue;
      const ms = Date.parse(t.at);
      if (range && (ms < range.startMs || ms > range.endMs)) continue;
      out.push({
        touchId: t.id, bidId: b.id, agencyName: b.agencyName, agencyType: b.agencyType, bidTitle: b.title, kind: b.kind, stage: b.stage,
        touchKind: t.kind, source: t.source, who: touchWho(t, d, opts.contactNames), note: t.note, at: t.at,
        author: t.authorId && opts.authorName ? opts.authorName(t.authorId) : null, bidTimezone: b.timezone,
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.touchId.localeCompare(b.touchId));
}

const SOURCE_LABELS: Record<TouchSource, string> = { manual: '', nudge: 'Nudge', followup: 'Follow-up' };

function fmtAt(r: TouchReportRow): string {
  const d = DateTime.fromISO(r.at).setZone(r.bidTimezone);
  return d.isValid ? d.toFormat('yyyy-MM-dd h:mm a ZZZZ') : '';
}

export const TOUCH_COLUMNS: (CsvColumn<TouchReportRow> & { width: number })[] = [
  { header: 'Date', width: 22, value: fmtAt },
  { header: 'Agency', width: 24, value: (r) => r.agencyName },
  { header: 'Bid Title', width: 30, value: (r) => r.bidTitle },
  { header: 'Kind', width: 8, value: (r) => (r.kind === 'rfq' ? 'Quote' : 'Bid') },
  { header: 'Stage', width: 12, value: (r) => stageLabel(r.kind, r.stage) },
  { header: 'Type', width: 10, value: (r) => TOUCH_KIND_LABELS[r.touchKind] },
  { header: 'With', width: 22, value: (r) => r.who },
  { header: 'Note', width: 50, value: (r) => r.note },
  { header: 'Source', width: 10, value: (r) => SOURCE_LABELS[r.source] },
  { header: 'Author', width: 18, value: (r) => r.author },
];
