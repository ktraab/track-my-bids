import { describe, it, expect } from 'vitest';
import {
  bidTouchLine, businessDaysAhead, canDeleteTouch, chipAt, dayOf, defaultNextAt, dueAtOf, nextLine, nextPatch, partyOf, pickedDayIso,
  recentTouches, tickTooltip, touchParty, touchTitle, touchWho, withOptions,
} from './touches';
import { makeBid, makeMilestone, makeQuote, makeTouch, makeVendorQuote, withChildren } from './fixtures';
import type { BidContact } from './types';

const NY = 'America/New_York';
const NOW = Date.parse('2026-11-18T20:00:00Z'); // Wed Nov 18, 15:00 ET (Thanksgiving is Thu Nov 26, Fri 27 is off too)
const S = { nextDefaultBusinessDays: 5 };
const bid = makeBid({ timezone: NY });

const dana: BidContact = {
  linkId: 'l1', bidId: 'b1', role: 'procurement',
  contact: { id: 'c1', firstName: 'Dana', lastName: 'Ortiz', title: null, organization: null, email: null, phone: null, notes: null, createdAt: '', updatedAt: '', deletedAt: null },
};

describe('touchParty / touchWho / touchTitle', () => {
  const d = { ...withChildren(bid, []), contacts: [dana], vendorQuotes: [makeVendorQuote('v1', { vendorName: 'SHI' })] };
  it('vendor beats contact; nobody is none', () => {
    expect(touchParty({ contactId: null, vendorQuoteId: 'v1' })).toBe('vendor');
    expect(touchParty({ contactId: 'c1', vendorQuoteId: null })).toBe('customer');
    expect(touchParty({ contactId: null, vendorQuoteId: null })).toBe('none');
  });
  it('names the linked contact, the vendor, an unlinked contact from the map, or nobody', () => {
    expect(touchWho({ contactId: 'c1', vendorQuoteId: null }, d)).toBe('Dana Ortiz');
    expect(touchWho({ contactId: null, vendorQuoteId: 'v1' }, d)).toBe('SHI');
    expect(touchWho({ contactId: 'c9', vendorQuoteId: null }, d, new Map([['c9', 'R. Kim']]))).toBe('R. Kim');
    expect(touchWho({ contactId: 'c9', vendorQuoteId: null }, d)).toBe('Contact');
    expect(touchWho({ contactId: null, vendorQuoteId: null }, d)).toBeNull();
    expect(touchTitle(makeTouch('t', 'x', { contactId: 'c1' }), d)).toBe('Call · Dana Ortiz');
    expect(touchTitle(makeTouch('t', 'x', { kind: 'note' }), d)).toBe('Note');
  });
});

describe('businessDaysAhead / chipAt', () => {
  it('lands at 09:00 in the bid zone, skipping weekends and Thanksgiving', () => {
    expect(businessDaysAhead(NOW, NY, 2)).toBe('2026-11-20T09:00:00.000-05:00');
    expect(chipAt('w1', NOW, NY)).toBe('2026-11-25T09:00:00.000-05:00');
    expect(chipAt('w2', NOW, NY)).toBe('2026-12-04T09:00:00.000-05:00');
    expect(chipAt('pick', NOW, NY)).toBeNull();
  });
});

describe('defaultNextAt', () => {
  it('an existing next step is kept (any kind, bids and RFQs)', () => {
    const b = makeBid({ timezone: NY, nextAt: '2026-11-27T14:00:00.000Z' });
    expect(defaultNextAt(b, null, 'call', NOW, S)).toEqual({ chip: 'keep', at: '2026-11-27T14:00:00.000Z' });
    expect(defaultNextAt(b, null, 'note', NOW, S).chip).toBe('keep');
    expect(defaultNextAt(makeQuote({ nextAt: '2026-11-27T14:00:00.000Z' }), null, 'call', NOW, S).chip).toBe('keep');
  });
  it('a note with no next step offers none; an RFQ defaults to none', () => {
    expect(defaultNextAt(bid, null, 'note', NOW, S)).toEqual({ chip: 'none', at: null });
    expect(defaultNextAt(makeQuote({ timezone: NY }), null, 'call', NOW, S)).toEqual({ chip: 'none', at: null });
  });
  it('a bid defaults to the setting in business days at 09:00 (5 = the 1 week chip, others = Pick date)', () => {
    expect(defaultNextAt(bid, null, 'call', NOW, S)).toEqual({ chip: 'w1', at: '2026-11-25T09:00:00.000-05:00' });
    expect(defaultNextAt(bid, null, 'email', NOW, { nextDefaultBusinessDays: 2 })).toEqual({ chip: 'd2', at: '2026-11-20T09:00:00.000-05:00' });
    expect(defaultNextAt(bid, null, 'meeting', NOW, { nextDefaultBusinessDays: 3 })).toEqual({ chip: 'pick', at: '2026-11-23T09:00:00.000-05:00' });
  });
  it('caps at one business day before the due date', () => {
    // Due Tue Nov 24 → cap Mon Nov 23 09:00.
    expect(defaultNextAt(bid, '2026-11-24T14:00:00.000-05:00', 'call', NOW, S)).toEqual({ chip: 'pick', at: '2026-11-23T09:00:00.000-05:00' });
    // Due Mon Nov 30 → cap skips Thanksgiving weekend back to Wed Nov 25, which equals the default: no cap.
    expect(defaultNextAt(bid, '2026-11-30T14:00:00.000-05:00', 'call', NOW, S)).toEqual({ chip: 'w1', at: '2026-11-25T09:00:00.000-05:00' });
  });
  it('none when the capped date is not after now', () => {
    expect(defaultNextAt(bid, '2026-11-19T14:00:00.000-05:00', 'call', NOW, S)).toEqual({ chip: 'none', at: null });
  });
  it('dueAtOf finds the live due milestone', () => {
    expect(dueAtOf(withChildren(bid, [makeMilestone('m1', 'pre_bid', 'x'), makeMilestone('m2', 'due', '2026-12-01T15:00:00.000Z')]))).toBe('2026-12-01T15:00:00.000Z');
    expect(dueAtOf(withChildren(bid, []))).toBeNull();
  });
});

describe('Status column lines', () => {
  it('next step with text, without text, overdue in red', () => {
    expect(nextLine({ nextAt: '2026-11-20T14:00:00.000Z', nextText: 'send revised quote' }, NOW, NY))
      .toEqual({ text: 'Next · send revised quote · Friday', overdue: false });
    expect(nextLine({ nextAt: '2026-11-20T14:00:00.000Z', nextText: null }, NOW, NY)).toEqual({ text: 'Next step · Friday', overdue: false });
    expect(nextLine({ nextAt: '2026-11-17T14:00:00.000Z', nextText: 'call Dana' }, NOW, NY)).toEqual({ text: 'Next · call Dana · yesterday', overdue: true });
    expect(nextLine({ nextAt: null, nextText: 'x' }, NOW, NY)).toBeNull();
  });
  it('bids: next step first, else the last touch, else no touches yet', () => {
    const t = [makeTouch('t2', '2026-11-16T19:00:00.000Z', { kind: 'email' }), makeTouch('t1', '2026-11-10T19:00:00.000Z')];
    expect(bidTouchLine({ bid, touches: t }, NOW, NY)).toEqual({ text: 'Last: Email · 2d ago', overdue: false });
    expect(bidTouchLine({ bid, touches: [makeTouch('t', '2026-11-18T19:59:00.000Z')] }, NOW, NY).text).toBe('Last: Call · just now');
    expect(bidTouchLine({ bid, touches: [] }, NOW, NY)).toEqual({ text: 'No touches yet', overdue: false });
    expect(bidTouchLine({ bid: makeBid({ nextAt: '2026-11-20T14:00:00.000Z', nextText: 'call' }), touches: t }, NOW, NY).text).toBe('Next · call · Friday');
    const lost = makeBid({ timezone: NY, stage: 'lost', nextAt: '2026-11-10T14:00:00.000Z', nextText: 'call' });
    expect(bidTouchLine({ bid: lost, touches: t }, NOW, NY)).toEqual({ text: 'Last: Email · 2d ago', overdue: false });
  });
});

describe('canDeleteTouch', () => {
  it('Local mode always; Team mode: author, bid owner (or unowned bid), admin', () => {
    const t = { authorId: 'u1' };
    expect(canDeleteTouch(t, { ownerId: 'u2' }, null, null)).toBe(true);
    expect(canDeleteTouch(t, { ownerId: 'u2' }, 'u1', 'member')).toBe(true);
    expect(canDeleteTouch(t, { ownerId: 'u2' }, 'u2', 'member')).toBe(true);
    expect(canDeleteTouch(t, { ownerId: 'u2' }, 'u3', 'admin')).toBe(true);
    expect(canDeleteTouch(t, { ownerId: 'u2' }, 'u3', 'member')).toBe(false);
    expect(canDeleteTouch(t, { ownerId: null }, 'u3', 'member')).toBe(true);
  });
});

describe('recentTouches / tickTooltip', () => {
  it('takes the newest three', () => {
    const ts = ['a', 'b', 'c', 'd'].map((id) => makeTouch(id, '2026-11-10T00:00:00.000Z'));
    expect(recentTouches({ touches: ts }).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
  it('kind · who · date — note cut at 80 characters', () => {
    const d = { ...withChildren(bid, []), contacts: [dana] };
    const long = 'x'.repeat(100);
    expect(tickTooltip(makeTouch('t', '2026-11-18T19:10:00.000Z', { contactId: 'c1', note: 'Asked about AP count' }), d, NY))
      .toBe('Call · Dana Ortiz · Nov 18 — Asked about AP count');
    expect(tickTooltip(makeTouch('t', '2026-11-18T19:10:00.000Z', { note: long }), d, NY)).toBe(`Call · Nov 18 — ${'x'.repeat(79)}…`);
    expect(tickTooltip(makeTouch('t', '2026-11-18T19:10:00.000Z', { kind: 'note' }), d, NY)).toBe('Note · Nov 18');
  });
});

describe('composer: next step on save', () => {
  const planned = makeBid({ timezone: NY, nextAt: '2026-11-27T14:00:00.000Z', nextText: 'send revised quote' });
  it('keep leaves the step alone unless its text changed', () => {
    expect(nextPatch(planned, 'keep', '', 'send revised quote', NOW)).toBeUndefined();
    expect(nextPatch(planned, 'keep', '', ' call Dana ', NOW)).toEqual({ nextAt: '2026-11-27T14:00:00.000Z', nextText: 'call Dana' });
  });
  it('none clears an existing step (and does nothing when there is none)', () => {
    expect(nextPatch(planned, 'none', '', '', NOW)).toEqual({ nextAt: null, nextText: null });
    expect(nextPatch(bid, 'none', '', '', NOW)).toBeUndefined();
  });
  it('a chip or a picked day sets date (09:00 bid zone) and text', () => {
    expect(nextPatch(bid, 'w1', '', 'follow up', NOW)).toEqual({ nextAt: '2026-11-25T09:00:00.000-05:00', nextText: 'follow up' });
    expect(nextPatch(bid, 'pick', '2026-12-02', '', NOW)).toEqual({ nextAt: '2026-12-02T09:00:00.000-05:00', nextText: null });
    expect(() => nextPatch(bid, 'pick', '', '', NOW)).toThrow('Pick a date');
  });
  it('pickedDayIso / dayOf convert between date inputs and ISO in the bid zone', () => {
    expect(pickedDayIso('2026-12-02', NY)).toBe('2026-12-02T09:00:00.000-05:00');
    expect(pickedDayIso('', NY)).toBeNull();
    expect(dayOf('2026-11-27T02:00:00.000Z', NY)).toBe('2026-11-26');
    expect(dayOf(null, NY)).toBe('');
  });
});

describe('composer: With choices', () => {
  const it2 = { ...dana, linkId: 'l2', role: 'it' as const, contact: { ...dana.contact, id: 'c2', firstName: 'Ray', lastName: 'Kim' } };
  const d = { contacts: [it2, dana], vendorQuotes: [makeVendorQuote('v1', { vendorName: 'SHI' }), makeVendorQuote('v2', { deletedAt: 'x' })] };
  const all = [{ id: 'c1', name: 'Dana Ortiz' }, { id: 'c3', name: 'Ann Lee' }, { id: 'c4', name: 'Bo Diaz' }];
  it('linked contacts (Procurement first), then live vendors, then other contacts filtered by search', () => {
    const o = withOptions(d, all);
    expect(o.linked.map((x) => x.value)).toEqual(['c:c1', 'c:c2']);
    expect(o.vendors).toEqual([{ value: 'v:v1', label: 'SHI' }]);
    expect(o.others.map((x) => x.label)).toEqual(['Ann Lee', 'Bo Diaz']);
    expect(withOptions(d, all, 'bo').others.map((x) => x.label)).toEqual(['Bo Diaz']);
  });
  it('partyOf decodes a choice', () => {
    expect(partyOf('c:c1')).toEqual({ contactId: 'c1', vendorQuoteId: null });
    expect(partyOf('v:v1')).toEqual({ contactId: null, vendorQuoteId: 'v1' });
    expect(partyOf('')).toEqual({ contactId: null, vendorQuoteId: null });
  });
});
