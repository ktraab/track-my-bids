import type { Line } from './extract';

/** Shared role mailboxes are not personal: kept so rules can still learn from them. */
const ROLE_MAILBOX = /^(?:bids?|purchasing|procurement|info|erate|e-rate|rfp|rfps|quotes?|contracts?|buyer|finance|admin|webmaster|support|prara?|pra)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const SEP = String.raw`(?:\s*[./-]\s*|\s+)`;
/** An extension after a number: "ext.51812", "X131", "x 154", "extension 12". */
const EXT = String.raw`(?:\s*,?\s*(?:ext(?:ension)?\.?|x)\s*\d{1,6}(?!\d))?`;
/** "(555) 201-3344", "(555)-201-3344", "555/201-3344", "555 - 201 - 3344", "+1 555.201.3344", "1-555-201-3344", with an extension. */
const PHONE = new RegExp(String.raw`(?<![\w+])(?:\+?1${SEP})?(?:\(\d{3}\)\s*-?\s*|\d{3}${SEP})\d{3}${SEP}\d{4}(?!\d)${EXT}`, 'gi');
/** A number right after a phone label: 10 bare digits or a 7-digit "201-3344" (a bare 10-digit number elsewhere may be an FCC
 *  registration or a Form 470 number, so it needs the label). */
const LABELLED_PHONE = new RegExp(String.raw`(\b(?:phone|telephone|tel|fax|cell|mobile|ph)\b\.?\s*(?:#|no\.?|number)?\s*[:|-]?\s*)((?:\+?1[\s.-]?)?\d{10}(?!\d)|(?<!\d[\s.-]?)\d{3}[\s.-]\d{4}(?!\d))${EXT}`, 'gi');
/** A query string that may carry a session, a checksum or our vendor id: it is dropped from the URL. */
const URL = /\bhttps?:\/\/[^\s|<>"]+|\bwww\.[^\s|<>"]+/gi;
const SESSION_URL = /session|sid|cs=|token|vendorid/i;
/** "Jane Doe" / "Jane Q. Doe" next to an email or a "Contact" label: probably a person (ALL-CAPS names are caught
 *  through their Title Case spelling, or listed in redact.json). */
const NAME_AT = /^([A-Z][a-z]+)(?:\s+[A-Z]\.?)?\s+([A-Z][a-z][A-Za-z'’-]*)\b/;
/** An ALL-CAPS name right before an email in the same cell: "WELCOME JANE DOE (jdoe@x.org)", "JANE Q. DOE Email: jdoe@x.org". */
const CAPS_BEFORE_EMAIL = /\b([A-Z][A-Z'’-]+)(?:\s+[A-Z]\.?)?\s+([A-Z][A-Z'’-]+)\s*(?:\(|e-?mail\s*:?|[-:–])?\s*$/i;
const FAKE_NAMES = ['Pat Morgan', 'Sam Rivera', 'Alex Chen', 'Jordan Lee', 'Casey Brooks', 'Riley Shaw', 'Drew Patel', 'Morgan Diaz',
  'Taylor Reed', 'Jamie Fox', 'Avery Cole', 'Quinn Hart', 'Robin Gray', 'Skyler Ward', 'Cameron Bell', 'Reese Lane'];
/** Capitalized words that are never a person's name in these documents. */
const NOT_NAME = /^(?:the|and|for|of|to|in|on|at|by|or|city|county|state|school|district|public|schools|board|education|department|purchasing|procurement|contact|information|email|phone|fax|name|title|bid|bids|rfp|rfq|ifb|form|fcc|usac|funding|year|category|billed|entity|number|application|consultant|consultants|consulting|firm|firms|registration|authorized|person|technical|address|street|suite|avenue|road|services?|internal|connections|basic|maintenance|network|equipment|request|proposal|proposals|questions|submit|submission|vendor|vendors|company|inc|llc|corporation|office|division|agent|buyer|officer|manager|director|specialist|coordinator|mayor|eligible|entities|recipient|type|applicant|library|catholic|community|church|university|college|county's|description|data|transmission|internet|access|other|wireless|switches|firewall|cabling|racks|ups|due|date|time|page|section|addendum|signature|print|response|details|report|status|submitted|total|price|unit|quantity|item|items|line|lines|no|yes|n\/a|na|eastern|central|pacific|mountain|daylight|standard|current|end|start|anticipated|delivery|header|work|informal|shipping|requisitions|supporting|documentation|bidding|option|shipped|notes|reference|brand|new|united|states|executive|order|purchase|allowable|contract|applicable|laws|program|support|customer|technology|user|guide|about|us|blvd|ave|st|rd|dr|ln|hwy|pkwy|helpdesk|help|desk|assistant|superintendent|letters|patent|certification|regarding|commodities|revised|acceptance|period|battery|backups|attention|attn|submit|questions|drive|lane|court|way|circle|place|parkway|boulevard|highway|approver|agency|format)$/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words after a capitalized pair that make it a place or an organization ("Idaho Falls School District", "Jordan Lee Pkwy"). */
const PLACE_AFTER = /^,?\s+(?:school|schools|district|public|county|city|parish|falls|parkway|pkwy|street|st\b|avenue|ave\b|road|rd\b|boulevard|blvd|drive|dr\b|lane|ln\b|way|court|ct\b|place|pl\b|highway|hwy|library|church|academy|college|university|catholic|unified|union|community|center|centre|hall|park|elementary|middle|high|isd|usd|department|office|board|township|village|town|area|valley|heights|beach|springs?|hills?|lake|river|harbor|bay|county's|city's|campus|building|plaza|square|center's|regional|independent|consolidated|parochial|diocese|archdiocese|transit|authority|commission|institute)\b/i;
/** "<Place>, ID 83401", "<Place>, Idaho": a city in an address. */
const CITY_AFTER = /^,?\s+(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/i;
const STATE_CODE_AFTER = /^,?\s+[A-Z]{2}\b(?!\.)/;
/** "City of <Place>", "123 <Street>", "St. <Saint>": not a person. */
const PLACE_BEFORE = /(?:\b(?:city|county|town|village|township|state|commonwealth|borough|parish)\s+of\s+|\b\d+\s+|\bst\.?\s+|\bsaint\s+|\bmt\.?\s+|\bfort\s+|\bport\s+|\bnew\s+|\bnorth\s+|\bsouth\s+|\beast\s+|\bwest\s+|[A-Za-z]-)$/i;
const CONTACT_LABEL = /\b(?:contact|attn|attention|buyer|purchaser|authorized person|recipient name|prepared by|submitted by|ship-to|bill-to)\b|^from\s*:/i;

/**
 * Probable person names: a "First Last" pair on or next to a line with an email or a contact label, unless the
 * document ever uses that pair as a place or an organization (followed by "School", "County", ", ID 83401"…,
 * or after "City of", a house number, "St."). Errs toward keeping place and agency names intact.
 */
export function personNames(lines: Line[]): string[] {
  const found = new Set<string>();
  // Words the document also writes in lower case are ordinary words ("Allowable Contract"), not a person's name.
  const lower = new Set(lines.flatMap((l) => l.text.replace(EMAIL, ' ').replace(/\S+\.(?:com|org|net|gov|edu|us)\S*/gi, ' ').match(/\b[a-z][a-z'’-]+\b/g) ?? []));
  const common = (w: string) => lower.has(w.toLowerCase());
  lines.forEach((l, i) => {
    const near = new RegExp(EMAIL.source).test(l.text) || CONTACT_LABEL.test(l.text);
    if (!near) return;
    for (const t of lines.slice(Math.max(0, i - 1), i + 2).filter((x) => x.page === l.page)) {
      for (const cell of t.text.split(' | ')) {
        // Try every capitalized word as a start, so "Attention Ann Lee" still finds "Ann Lee".
        for (const w of cell.matchAll(/\b[A-Z][a-z]/g)) {
          const m = cell.slice(w.index).match(NAME_AT);
          if (!m) continue;
          if (NOT_NAME.test(m[1]) || NOT_NAME.test(m[2]) || (common(m[1]) && common(m[2]))) continue;
          found.add(m[0]);
        }
        for (const e of cell.matchAll(EMAIL)) {
          const m = cell.slice(0, e.index).match(CAPS_BEFORE_EMAIL);
          if (!m || m[0].trim() === m[0].trim().toLowerCase() || /[a-z]/.test(m[1] + m[2])) continue;
          if (NOT_NAME.test(m[1]) || NOT_NAME.test(m[2]) || (common(m[1]) && common(m[2]))) continue;
          found.add(m[0].replace(/\s*(?:\(|e-?mail\s*:?|[-:–])?\s*$/i, ''));
        }
      }
    }
  });
  const isPlace = (name: string) => {
    const re = new RegExp(`\\b${escapeRe(name).replace(/\s+/g, '\\s+')}\\b`, 'gi');
    return lines.some((l) => [...l.text.matchAll(re)].some((m) => {
      const after = l.text.slice(m.index! + m[0].length);
      return PLACE_AFTER.test(after) || CITY_AFTER.test(after) || STATE_CODE_AFTER.test(after) || PLACE_BEFORE.test(l.text.slice(0, m.index!));
    }));
  };
  return [...found].filter((n) => !isPlace(n));
}

export interface RedactOptions {
  /** Extra exact replacements (case-insensitive), e.g. your own company and people: { "Acme Supply": "Our Company" }. */
  replace?: Record<string, string>;
}


/**
 * Replace personal data in document lines before they are committed as test fixtures: email local parts
 * (role mailboxes kept), phone numbers, names found next to an email / "Contact"-style label, and any
 * strings listed in `replace`. Deterministic: the same input gives the same output. Agency names stay.
 */
export function redactLines(lines: Line[], opts: RedactOptions = {}): Line[] {
  const emails = new Map<string, string>();
  const phones = new Map<string, string>();
  const names = new Map<string, string>();
  for (const [from, to] of Object.entries(opts.replace ?? {})) if (from.trim()) names.set(from.trim().toLowerCase(), to);

  // Count found names on their own, so adding a `replace` entry does not reshuffle every fake name.
  let found = 0;
  for (const n of personNames(lines)) {
    const key = n.toLowerCase();
    if (!names.has(key)) names.set(key, FAKE_NAMES[found++ % FAKE_NAMES.length]);
  }
  const nameRes = [...names.entries()].sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => [new RegExp(`(?<![\\w])${escapeRe(from).replace(/\s+/g, '\\s+')}(?![\\w])`, 'gi'), to] as const);

  return lines.map((l) => {
    let t = l.text.replace(EMAIL, (e) => {
      const [local, domain] = e.split('@');
      if (ROLE_MAILBOX.test(local)) return e;
      const key = e.toLowerCase();
      if (!emails.has(key)) emails.set(key, `person${emails.size + 1}@${domain.toLowerCase()}`);
      return emails.get(key)!;
    });
    const fake = (p: string) => {
      const key = p.replace(/\D/g, '').slice(-10);
      if (!phones.has(key)) phones.set(key, `555-555-${String(100 + phones.size).padStart(4, '0')}`);
      return phones.get(key)!;
    };
    t = t.replace(URL, (u) => (SESSION_URL.test(u.slice(u.indexOf('?') + 1 || u.length)) ? u.replace(/\?.*$/, '') : u));
    t = t.replace(PHONE, (p) => fake(p.replace(/\s*,?\s*(?:ext(?:ension)?\.?|x)\s*\d+$/i, '')));
    t = t.replace(LABELLED_PHONE, (_m, label: string, p: string) => label + fake(p));
    for (const [re, to] of nameRes) t = t.replace(re, to);
    return { text: t, page: l.page };
  });
}

/** A price with cents: "$4,348.51", "$ 0.00". */
const MONEY = /\$\s?\d{1,3}(?:,?\d{3})*\.\d{2}(?!\d)/g;
/** A price table header: "Unit Price Qty. | Total", "Line Item | Quantity | Unit Price | Amount". */
const PRICE_HEADER = /\bunit\s+(?:price|cost)\b.{0,60}\b(?:total|amount|extended|ext\.?)\b/i;
/** A heading that starts a vendor's own response in a portal printout (a whole line, so prose like "Your bid shall…" does not count). */
const RESPONSE_START = /^(?:vendor response|your (?:bid|response|quote)|bid response|quote response|submitted bid)s?\s*:?$/i;
/** A company line ("Acme Supply Dist., Inc.", "JANE DOE - ACME LLC"): the bidder heading its response. */
const COMPANY_LINE = /\b(?:inc|llc|corp|corporation|company|co|ltd|dist|distribution|distributors?|supply)\b\.?/i;
/** A table row of prices: two prices with only quantities, units and cell bars between them ("$4.50 2 $9.00", "$4.50 | $9.00"). */
const PRICE_ROW = /\$\s?[\d,]+\.\d{2}(?:\s*\|?\s*\d*\s*(?:ea|each|units?)?\s*\|?\s*)\$\s?[\d,]+\.\d{2}/i;

/** A table row holding a price (a cell row, a price pair, or a short line), not a sentence that mentions one. */
const priceCell = (t: string) => new RegExp(MONEY.source).test(t) && (t.includes(' | ') || PRICE_ROW.test(t) || t.length <= 30);
/** A filled price table starts at line i: a header row (cells or a short line, not a sentence) with a price row within the next three lines. */
const filledTableAt = (lines: Line[], i: number) => {
  const t = lines[i].text.trim();
  return PRICE_HEADER.test(t) && (t.includes(' | ') || t.length < 60) && !/[.;]$/.test(t)
    && lines.slice(i, i + 4).some((x) => x.page === lines[i].page && priceCell(x.text));
};

/**
 * Drop the bidder's own response from a portal printout ("Vendor Response", "Your Bid", a filled "Unit Price … Total" table):
 * from that line to the end of its page, plus the company line just above it. Fixtures keep the solicitation header only,
 * so a team's quoted prices never reach the repo.
 */
export function stripBidResponses(lines: Line[]): Line[] {
  const drop = new Set<number>();
  lines.forEach((l, i) => {
    if (drop.has(i) || !(RESPONSE_START.test(l.text.trim()) || filledTableAt(lines, i))) return;
    if (i > 0 && lines[i - 1].page === l.page && COMPANY_LINE.test(lines[i - 1].text) && lines[i - 1].text.length < 100) drop.add(i - 1);
    for (let k = i; k < lines.length && lines[k].page === l.page; k++) drop.add(k);
  });
  return lines.filter((_, i) => !drop.has(i));
}

/** Lines that still look like a bidder's response or a filled price table (the fixture generator refuses to write them). */
export function priceTableLines(lines: Line[]): Line[] {
  return lines.filter((l, i) => RESPONSE_START.test(l.text.trim()) || filledTableAt(lines, i) || PRICE_ROW.test(l.text));
}
