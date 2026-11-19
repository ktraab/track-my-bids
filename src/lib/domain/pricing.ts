import type { Bid, BidWithChildren, MarkupType, QuoteLine, VendorQuote } from './types';
import { liveVendors } from './rfq';

/** Spec §2. Money is REAL dollars; only display and `sell_rounding` round. */

export interface Markup {
  type: MarkupType;
  value: number;
}

/** Settings → Pricing (device setting `pricing`). Pinned onto a bid when it gets its first line. */
export interface PricingDefaults {
  markupType: MarkupType;
  markupValue: number;
}

export const DEFAULT_PRICING: PricingDefaults = { markupType: 'pct', markupValue: 12 };
export const MARKUP_TYPES: MarkupType[] = ['pct', 'unit', 'line'];
export const MARKUP_LABELS: Record<MarkupType, string> = { pct: '%', unit: '$ / unit', line: '$ / line' };
export const SELL_ROUNDINGS = [0.01, 1, 5] as const;
export const ROUNDING_LABELS: Record<string, string> = { '0.01': 'to the cent', '1': 'to $1', '5': 'to $5' };

export const isMarkupType = (v: unknown): v is MarkupType => v === 'pct' || v === 'unit' || v === 'line';
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Validate the stored (untrusted) setting; type and value are kept or replaced together. */
export function withPricingDefaults(raw: unknown): PricingDefaults {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return isMarkupType(r.markupType) && isAmount(r.markupValue)
    ? { markupType: r.markupType, markupValue: r.markupValue }
    : { ...DEFAULT_PRICING };
}

export type MarkupSource = 'line' | 'quote' | 'settings';

/** The line's own markup, else the bid's, else Settings. A type without a value (or vice versa) counts as unset. */
export function effectiveMarkup(
  line: Pick<QuoteLine, 'markupType' | 'markupValue'>,
  bid: Pick<Bid, 'markupType' | 'markupValue'>,
  d: PricingDefaults,
): { markup: Markup; source: MarkupSource } {
  if (line.markupType && line.markupValue !== null) return { markup: { type: line.markupType, value: line.markupValue }, source: 'line' };
  if (bid.markupType && bid.markupValue !== null) return { markup: { type: bid.markupType, value: bid.markupValue }, source: 'quote' };
  return { markup: { type: d.markupType, value: d.markupValue }, source: 'settings' };
}

/** pct: cost × (1 + v/100); unit: cost + v; line: cost + v/qty. */
export function applyMarkup(cost: number, qty: number, m: Markup): number {
  if (m.type === 'pct') return cost * (1 + m.value / 100);
  if (m.type === 'unit') return cost + m.value;
  return qty > 0 ? cost + m.value / qty : cost;
}

/** Nearest multiple of `step` (half up), cleaned to cents. A bad step rounds to the cent. */
export function roundTo(n: number, step: number): number {
  const s = Number.isFinite(step) && step > 0 ? step : 0.01;
  // Half away from zero, so -2.5 → -3 like 2.5 → 3. `+ 0` turns -0 into 0.
  const k = Math.sign(n) * Math.round(Number((Math.abs(n) / s).toFixed(6)));
  return Number((k * s).toFixed(2)) + 0;
}

/** A fixed sell price wins as typed; otherwise cost plus markup, rounded to the bid's `sell_rounding`. */
export function unitSell(cost: number, qty: number, m: Markup, rounding: number, override: number | null): number {
  if (override !== null) return override;
  // A $/line markup spread over qty is often cents per unit; rounding that to $1 or $5 would wipe it out
  // (cost 10, qty 100, +$50 → 10.50, not 10). So it always rounds to the cent; pct and unit use sell_rounding.
  return roundTo(applyMarkup(cost, qty, m), m.type === 'line' ? 0.01 : rounding);
}

/** Markup implied by a fixed sell price, as a % of cost (null when cost is 0). */
export function derivedMarkupPct(cost: number, sell: number): number | null {
  return cost > 0 ? ((sell - cost) / cost) * 100 : null;
}

/** "$1,234.50" → 1234.5. Blank → null. Anything else that isn't a non-negative amount → undefined. */
export function parseAmount(s: string): number | null | undefined {
  const t = s.replace(/[\u00a0\u2009\u202f]/g, '').trim().replace(/^\$/, '').trim();
  if (!t) return null;
  // Commas only as proper thousands groups: "1,234.50" yes; "1,2,3" and "1,5" no.
  if (!/^((\d{1,3}(,\d{3})+|\d+)(\.\d*)?|\.\d+)$/.test(t)) return undefined;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The first line on a bid with no markup of its own pins the Settings default onto the bid, so the quote
 * total doesn't change with whoever (or whichever device) opens it. Null = nothing to pin.
 */
export function seedMarkup(
  bid: Pick<Bid, 'markupType' | 'markupValue'>, lineCount: number, d: PricingDefaults,
): { markupType: MarkupType; markupValue: number } | null {
  if (lineCount > 0 || (bid.markupType && bid.markupValue !== null)) return null;
  return { markupType: d.markupType, markupValue: d.markupValue };
}

// ── Grid: vendor totals, chosen vendors, sell prices, summary ──────────────────────────────

export type PricingData = Pick<BidWithChildren, 'bid' | 'vendorQuotes' | 'lines' | 'prices'>;

/** One vendor column's total. `total` null = "Missing lines" (or no lines yet). */
export interface VendorTotal {
  vendorId: string;
  total: number | null;
  priced: number; // lines this vendor priced
}

export interface LinePricing {
  line: QuoteLine;
  costs: (number | null)[]; // unit cost per grid vendor, in grid order
  lowestCost: number | null;
  chosenVendorId: string | null;
  unitCost: number | null; // the chosen vendor's cost
  markup: Markup;
  markupSource: MarkupSource;
  unitSell: number | null;
  lineTotal: number | null;
  derivedPct: number | null; // markup implied by a sell override
  flagged: boolean; // no chosen price → left out of the totals
}

export interface PricingSummary {
  vendorsUsed: string[]; // names, grid order
  cost: number;
  markup: number; // sell − cost, dollars
  marginPct: number | null; // (sell − cost) / sell × 100
  total: number; // the quote total
  priced: number;
  flagged: number;
}

export interface Pricing {
  vendors: VendorQuote[]; // grid columns = live vendors (skipped ones too), in the order asked
  totals: VendorTotal[];
  wholeVendorId: string | null; // whole mode: the vendor every line uses
  autoWhole: boolean; // true when that is the lowest complete total (no override)
  lines: LinePricing[];
  summary: PricingSummary;
}

/** Grid columns, and the order pasted price columns are matched to. */
export const gridVendors = (vqs: VendorQuote[]): VendorQuote[] => liveVendors(vqs);

function lowestIndex(xs: (number | null)[]): number {
  let best = -1;
  xs.forEach((x, i) => { if (x !== null && (best < 0 || x < xs[best]!)) best = i; });
  return best;
}

export function pricingOf(d: PricingData, defaults: PricingDefaults): Pricing {
  const vendors = gridVendors(d.vendorQuotes);
  const lines = d.lines.filter((l) => !l.deletedAt).sort((a, b) => a.position - b.position);
  const cost = new Map<string, number>();
  for (const p of d.prices) if (!p.deletedAt && p.unitCost !== null) cost.set(`${p.vendorQuoteId}:${p.lineId}`, p.unitCost);
  const costsOf = (l: QuoteLine) => vendors.map((v) => cost.get(`${v.id}:${l.id}`) ?? null);

  const totals: VendorTotal[] = vendors.map((v) => {
    let total = 0;
    let priced = 0;
    for (const l of lines) {
      const c = cost.get(`${v.id}:${l.id}`);
      if (c === undefined) continue;
      priced++;
      total += l.qty * c;
    }
    return { vendorId: v.id, total: lines.length && priced === lines.length ? total : null, priced };
  });

  const live = new Set(vendors.map((v) => v.id));
  const whole = d.bid.pricingMode === 'whole';
  const override = whole && d.bid.wholeVendorId && live.has(d.bid.wholeVendorId) ? d.bid.wholeVendorId : null;
  const lowestTotal = lowestIndex(totals.map((t) => t.total));
  const wholeVendorId = whole ? override ?? (lowestTotal >= 0 ? vendors[lowestTotal].id : null) : null;

  const out: LinePricing[] = lines.map((line) => {
    const costs = costsOf(line);
    const lo = lowestIndex(costs);
    const chosenVendorId = whole
      ? wholeVendorId
      : line.chosenVendorId && live.has(line.chosenVendorId) ? line.chosenVendorId : lo >= 0 ? vendors[lo].id : null;
    const unitCost = chosenVendorId ? costs[vendors.findIndex((v) => v.id === chosenVendorId)] : null;
    const { markup, source } = effectiveMarkup(line, d.bid, defaults);
    const sell = unitCost === null ? null : unitSell(unitCost, line.qty, markup, d.bid.sellRounding, line.sellOverride);
    return {
      line, costs, lowestCost: lo >= 0 ? costs[lo] : null, chosenVendorId, unitCost, markup, markupSource: source,
      unitSell: sell, lineTotal: sell === null ? null : sell * line.qty,
      derivedPct: unitCost !== null && line.sellOverride !== null ? derivedMarkupPct(unitCost, line.sellOverride) : null,
      flagged: sell === null,
    };
  });

  const counted = out.filter((l) => !l.flagged);
  const totalCost = counted.reduce((s, l) => s + l.unitCost! * l.line.qty, 0);
  const total = counted.reduce((s, l) => s + l.lineTotal!, 0);
  const used = new Set(counted.map((l) => l.chosenVendorId));
  return {
    vendors, totals, wholeVendorId, autoWhole: whole && override === null, lines: out,
    summary: {
      vendorsUsed: vendors.filter((v) => used.has(v.id)).map((v) => v.vendorName),
      cost: totalCost,
      markup: cents(total - totalCost),
      marginPct: total > 0 ? ((total - totalCost) / total) * 100 : null,
      total: cents(total),
      priced: counted.length,
      flagged: out.length - counted.length,
    },
  };
}

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "Our price": the quote total, or null when no line has a chosen price yet. */
export function quoteTotal(d: PricingData, defaults: PricingDefaults): number | null {
  if (!d.lines.some((l) => !l.deletedAt)) return null;
  const s = pricingOf(d, defaults).summary;
  return s.priced ? cents(s.total) : null;
}

// ── Paste from Excel ──────────────────────────────────────────────────────────────────────

export interface PastedRow {
  qty: number;
  description: string;
  partNo: string | null;
  prices: (number | null)[]; // one per grid vendor, in grid order
}

export interface PasteResult {
  rows: PastedRow[];
  skipped: number; // rows with no description
  header: boolean; // first row looked like column titles and was dropped
  extraColumns: number; // price columns beyond the vendors in the grid (ignored)
  qtyDefaulted: number; // rows whose qty was blank, zero or unreadable and became 1
}

/** Excel copies cells tab-separated and rows newline-separated, quoting a cell that holds a tab, newline or quote. */
export function splitTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  const endRow = () => {
    row.push(cell);
    if (row.some((c) => c.trim())) rows.push(row);
    row = [];
    cell = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && cell === '') {
      const start = i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { cell += '"'; i += 2; }
        else if (text[i] === '"') { i++; closed = true; break; }
        else cell += text[i++];
      }
      // Never closed: it was a literal quote, not Excel quoting. Re-read it unquoted so it can't eat the rest.
      if (!closed) { cell = '"'; i = start + 1; }
      continue;
    }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  endRow();
  return rows;
}

const QTY_RE = /^\$?([\d,]*\.?\d+)\s*[A-Za-z.]*$/;
/** "10", "1,200", "2 ea", "10 pcs" → the number; blank → null; anything else → undefined. */
export function parseQty(cell: string): number | null | undefined {
  const t = cell.replace(/[\u00a0\u2009\u202f]/g, ' ').trim();
  if (!t) return null;
  const m = QTY_RE.exec(t);
  return m ? parseAmount(m[1]) : undefined;
}

/**
 * Rows of `Qty, Description, Part #[, one price column per grid vendor…]`. Rows without a description are
 * skipped; a missing or bad quantity becomes 1; a blank or bad price is no price. A first row whose Qty cell
 * is text (e.g. "Qty", "#"), or is blank above a "Description"/"Item" title, is taken as a header. A qty may carry
 * a unit suffix ("2 EA").
 */
export function parsePaste(text: string, vendorCount: number): PasteResult {
  const out: PasteResult = { rows: [], skipped: 0, header: false, extraColumns: 0, qtyDefaulted: 0 };
  splitTsv(text).forEach((cells, i) => {
    const qtyCell = (cells[0] ?? '').trim();
    const descCell = (cells[1] ?? '').replace(/\s+/g, ' ').trim();
    if (i === 0 && (/^(qty|quantity|#|count)/i.test(qtyCell)
      || (qtyCell ? parseQty(qtyCell) === undefined : /^(desc|item)/i.test(descCell)))) { out.header = true; return; }
    const description = descCell;
    if (!description) { out.skipped++; return; }
    const q = parseQty(qtyCell);
    if (!(typeof q === 'number' && q > 0)) out.qtyDefaulted++;
    let last = cells.length - 1;
    while (last > 2 && !cells[last].trim()) last--;
    out.extraColumns = Math.max(out.extraColumns, last + 1 - 3 - vendorCount);
    out.rows.push({
      qty: typeof q === 'number' && q > 0 ? q : 1,
      description,
      partNo: (cells[2] ?? '').trim() || null,
      prices: Array.from({ length: vendorCount }, (_, k) => {
        const a = parseAmount(cells[3 + k] ?? '');
        return typeof a === 'number' ? a : null;
      }),
    });
  });
  return out;
}

/** The toast after a paste: "Added 2 lines and 3 prices. 1 row without a description skipped." */
export function pasteNotice(r: PasteResult, priced: number): string {
  const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [`Added ${s(r.rows.length, 'line')}${priced ? ` and ${s(priced, 'price')}` : ''}.`];
  if (r.skipped) parts.push(`${s(r.skipped, 'row')} without a description skipped.`);
  if (r.extraColumns) parts.push(`${s(r.extraColumns, 'price column')} ignored (more columns than vendors).`);
  if (r.qtyDefaulted) parts.push(`${s(r.qtyDefaulted, 'line')} had no qty, set to 1.`);
  return parts.join(' ');
}
