import type { BidWithChildren } from './types';
import { effectiveStops } from './stops';
import { METHOD_LABELS } from './labels';
import type { NotificationSettings } from './settings';

const MIN = 60_000;
const MEETING_TYPES = new Set(['pre_bid', 'site_walk']);

export interface CalEvent {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  description: string;
  location: string | null;
  alarmMinutes: number | null;
  /** Last edit of the source milestone (ship-by: the due milestone, else the bid). Drives LAST-MODIFIED/SEQUENCE. */
  updatedMs: number;
}

/** Calendar events for a bid's upcoming, not-done stops (including a sealed bid's ship-by). */
export function eventsForBid(data: BidWithChildren, nowMs: number, settings: NotificationSettings): CalEvent[] {
  const { bid } = data;
  const details = [
    `Bid: ${bid.title}${bid.bidNumber ? ` (${bid.bidNumber})` : ''}`,
    `Agency: ${bid.agencyName}`,
    `Submission: ${METHOD_LABELS[bid.submissionMethod]}${bid.portalName ? ` via ${bid.portalName}` : ''}`,
    bid.portalUrl ? `Portal: ${bid.portalUrl}` : null,
    bid.rfpUrl ? `RFP: ${bid.rfpUrl}` : null,
    'Added from TrackMyBids',
  ].filter(Boolean).join('\n');

  const due = data.milestones.find((m) => m.type === 'due');
  const shipByUpdated = Date.parse(due?.updatedAt ?? bid.updatedAt);

  return effectiveStops(data)
    .filter((s) => !s.done && s.ms >= nowMs)
    .map((s) => {
      const m = s.derived ? null : data.milestones.find((x) => x.id === s.id) ?? null;
      const offsets = s.derived
        ? settings.shipByOffsets
        : (m?.reminderOffsets ?? settings.reminderDefaults[s.milestoneType!] ?? []);
      const minutes = s.milestoneType && MEETING_TYPES.has(s.milestoneType) ? 60 : 30;
      const location = m?.location ?? (bid.submissionMethod === 'sealed' ? bid.deliveryAddress : bid.portalUrl) ?? null;
      return {
        uid: `${s.id.replace(/[^A-Za-z0-9-]/g, '-')}@trackmybids`,
        title: `${s.mandatory ? '[MANDATORY] ' : ''}${s.title}: ${bid.agencyName}`,
        startMs: s.ms,
        endMs: s.ms + minutes * MIN,
        description: details,
        location,
        alarmMinutes: offsets.length ? Math.min(...offsets) : null,
        updatedMs: s.derived ? shipByUpdated : Date.parse(m?.updatedAt ?? bid.updatedAt),
      };
    });
}

export function icsDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Monotonic with edits and within RFC 5545's INTEGER (int32) range. */
export function icsSequence(updatedMs: number): number {
  return Math.floor(updatedMs / 1000) % 2147483647;
}

/** Query string with encodeURIComponent (spaces → %20; some calendar clients show '+' literally). */
function query(params: Record<string, string | null | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
    .join('&');
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold to ≤ 75 octets per line (RFC 5545 §3.1), never splitting a UTF-8 character. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function toIcs(events: CalEvent[], nowMs: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TrackMyBids//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${icsDate(nowMs)}`,
      ...(Number.isFinite(e.updatedMs)
        ? [`LAST-MODIFIED:${icsDate(e.updatedMs)}`, `SEQUENCE:${icsSequence(e.updatedMs)}`]
        : []),
      `DTSTART:${icsDate(e.startMs)}`,
      `DTEND:${icsDate(e.endMs)}`,
      `SUMMARY:${escapeText(e.title)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
    );
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.alarmMinutes != null) {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, `TRIGGER:-PT${e.alarmMinutes}M`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(e: CalEvent): string {
  return `https://calendar.google.com/calendar/render?${query({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${icsDate(e.startMs)}/${icsDate(e.endMs)}`,
    details: e.description,
    location: e.location,
  })}`;
}

function outlookQuery(e: CalEvent): string {
  return query({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: e.title,
    startdt: new Date(e.startMs).toISOString(),
    enddt: new Date(e.endMs).toISOString(),
    body: e.description,
    location: e.location,
  });
}

/** Outlook on the web (Microsoft 365 work/school accounts). */
export function outlookCalendarUrl(e: CalEvent): string {
  return `https://outlook.office.com/calendar/0/deeplink/compose?${outlookQuery(e)}`;
}

/** Outlook.com (personal Microsoft accounts). */
export function outlookPersonalCalendarUrl(e: CalEvent): string {
  return `https://outlook.live.com/calendar/0/deeplink/compose?${outlookQuery(e)}`;
}

export function safeFileStem(s: string): string {
  return s.replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'TrackMyBids';
}
