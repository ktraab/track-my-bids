import { cleanLines, type LearnedLabel, type Line } from './extract';

/** Built-in scope tags and the words that suggest them (Settings → Document import shows these read-only). */
export const SCOPE_TAGS: readonly { tag: string; words: readonly string[] }[] = [
  { tag: 'Networking', words: ['switch', 'router', 'firewall', 'SFP', 'transceiver', 'Meraki', 'Cisco', 'Aruba'] },
  { tag: 'Wi-Fi', words: ['access point', 'wireless', 'WAP', 'AP', 'Wi-Fi', 'WiFi', 'WLAN'] },
  { tag: 'Cabling', words: ['Cat6', 'Cat6A', 'fiber', 'structured cabling', 'patch panel', 'drops', 'cabling', 'Cat5e', 'Cat5'] },
  { tag: 'Power / UPS', words: ['UPS', 'battery backup', 'PDU'] },
  { tag: 'Racks', words: ['rack', 'cabinet', 'enclosure'] },
  { tag: 'Computers', words: ['laptop', 'desktop', 'Chromebook', 'workstation', 'PC'] },
  { tag: 'Tablets', words: ['iPad', 'tablet'] },
  { tag: 'Displays', words: ['interactive display', 'interactive flat panel', 'monitor', 'projector', 'TV', 'interactive board', 'interactive whiteboard', 'smart board', 'interactive panel'] },
  { tag: 'Audio / Video', words: ['headset', 'headphones', 'speaker', 'microphone', 'camera', 'webcam'] },
  { tag: 'Printing', words: ['toner', 'printer', 'copier', 'MFP', 'ink'] },
  { tag: 'Radios', words: ['two-way radio', 'handheld radio', 'repeater', 'radio'] },
  { tag: 'Storage', words: ['SSD', 'flash drive', 'NAS', 'hard drive', 'SanDisk'] },
  { tag: 'Servers', words: ['server', 'virtualization', 'VMware'] },
  { tag: 'Security', words: ['camera system', 'access control', 'surveillance'] },
  { tag: 'Licensing', words: ['license', 'subscription', 'maintenance', 'support term'] },
  { tag: 'Installation', words: ['installation', 'configuration', 'provisioning'] },
];

/** Short ambiguous tokens: only all-capitals counts ("UPS", not "ups"). */
const CAPS_ONLY: ReadonlySet<string> = new Set(['AP', 'PC', 'TV', 'UPS', 'NAS', 'MFP', 'SSD', 'PDU', 'WAP', 'SFP']);

/**
 * Text that never counts. The spec's list, plus generic boilerplate that only looks like scope
 * (signing "in ink", labor law clauses, the Form 470 table's stock wording).
 */
const STOP_PHRASES = [
  'business license', "contractor's license", 'contractor’s license', 'contractors license', 'license to do business',
  'professional license', 'insurance', 'camera-ready', 'camera ready',
  'in ink', 'blue ink', 'ink signature', 'department of labor', 'labor code', 'labor law', 'labor laws', 'labor standards', 'child labor',
  'software and licenses', 'installation and initial configuration',
  // Contract boilerplate: equipment form factors, labor clauses, signing, attachments.
  'rack mount', 'rackmount', 'rack/tower', 'labor dispute', 'secretary of labor', 'labor relations', 'labor statistics', 'local labor',
  'project labor', 'labor agreement', 'prevailing wage', 'black ink', 'enclosure a', "governor's cabinet", 'governor’s cabinet',
  // Parts of a laptop's spec, not audio/video or display equipment.
  'integrated camera', 'integrated web camera', 'integrated webcam', 'integrated microphone', 'integrated speaker',
  'built-in camera', 'built-in microphone', 'built-in speaker', 'dual monitor', 'external monitor',
  // "monitor" the verb.
  'to monitor', 'will monitor', 'shall monitor', 'must monitor', 'may monitor', 'and monitor', 'monitor and',
  // UPS the carrier.
  'via UPS', 'UPS or FedEx', 'FedEx or UPS', 'UPS, FedEx', 'UPS ground', 'UPS tracking', 'UPS store', 'UPS freight',
  // Wi-Fi radios and web forms, not two-way radios.
  'dual-radio', 'tri-radio', 'quad-radio', 'radio frequency', 'radio button', 'radio station', 'radio advertising',
];
/** Form 470 table header rows and question-style column headings ("Configuration?"): column names, not scope. */
const HEADER_ROW = /^service type \| function\b/i;
const QUESTION_CELL = /(?:^|\| )[^|]*\?(?= \||$)/g;

export const MAX_TAGS = 5;
/** A document with fewer cleaned lines than this (a one-page quote request) counts a tag from 1 hit. */
const SHORT_DOC_LINES = 60;
/** Installation / Licensing words fill contract terms: outside the scope section they need this many hits. */
const SERVICE_MIN_HITS = 3;
/** A tag with under this share of the top tag's hits (and none in the scope section) is noise in a big document. */
const MIN_SHARE_OF_TOP = 0.1;
export const TAG_FIELD_PREFIX = 'scope_tag:';

export interface TagDef {
  tag: string;
  /** Built-in words (empty for a team-made tag). */
  words: readonly string[];
  /** Words the team added (stored lowercase). */
  custom: string[];
  builtIn: boolean;
}

/** A tag name as matched and saved: whitespace runs collapsed, trimmed. */
export const normTagName = (s: string) => s.replace(/\s+/g, ' ').trim();

export const MAX_TAG_NAME = 30;

/** A tag name and word from Settings, whitespace normalised, or why they can't be saved. */
export function checkTagWord(tag: string, word: string): { tag: string; word: string } | { error: string } {
  if (/[·\r\n]/.test(tag) || /[·\r\n]/.test(word)) return { error: 'Tag names and words can’t contain “·” or line breaks.' };
  const t = normTagName(tag);
  const w = word.replace(/\s+/g, ' ').trim();
  if (!t) return { error: 'Give the tag a name.' };
  if (t.length > MAX_TAG_NAME) return { error: `Tag names can be at most ${MAX_TAG_NAME} characters.` };
  if ((w.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return { error: 'A word needs at least 2 letters or digits.' };
  return { tag: t, word: w };
}

/** Built-in tags with the team's words merged in; team-made tags follow, in the order first seen. */
export function scopeTagDefs(learned: readonly LearnedLabel[]): TagDef[] {
  const defs: TagDef[] = SCOPE_TAGS.map((t) => ({ tag: t.tag, words: t.words, custom: [], builtIn: true }));
  for (const l of learned) {
    if (!l.field.startsWith(TAG_FIELD_PREFIX)) continue;
    const name = normTagName(l.field.slice(TAG_FIELD_PREFIX.length));
    const word = l.phrase.trim();
    if (!name || !word) continue;
    let def = defs.find((d) => d.tag.toLowerCase() === name.toLowerCase());
    if (!def) defs.push(def = { tag: name, words: [], custom: [], builtIn: false });
    if (!def.custom.includes(word)) def.custom.push(word);
  }
  return defs;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "two-way" is also written "2-way". */
const NUMBER_WORD: Record<string, string> = { one: '1', two: '2', three: '3', four: '4' };

/** Whole word(s); any run of spaces or a hyphen between words; "Cat6" also as "Cat 6" / "Cat-6"; "two" as "2"; plural "s"/"es". */
function wordRegex(word: string, caps = CAPS_ONLY.has(word)): RegExp {
  const body = word.trim().split(/[\s-]+/)
    .map((w) => (NUMBER_WORD[w.toLowerCase()] ? `(?:${escapeRe(w)}|${NUMBER_WORD[w.toLowerCase()]})` : escapeRe(w).replace(/([a-z])(\d)/gi, '$1[\\s-]?$2')))
    .join('[\\s-]+');
  const plural = /s$/i.test(word) ? '' : caps ? 's?' : '(?:e?s)?';
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${plural}(?![\\p{L}\\p{N}])`, caps ? 'gu' : 'giu');
}

/** Stop-phrases also stop in the plural ("business licenses", "labor codes"). */
const STOP_RES = STOP_PHRASES.map((p) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p).replace(/\\-|-/g, '[\\s-]?')}(?:e?s)?(?![\\p{L}\\p{N}])`, 'giu'));

/**
 * A team word (saved lowercase) that the dictionary keeps to capitals, or one of ≤ 3 letters/digits ("kvm"),
 * counts only in capitals, like the built-in short words.
 */
function teamWordRegex(word: string): RegExp {
  const upper = word.toUpperCase();
  return CAPS_ONLY.has(upper) || /^[\p{L}\p{N}]{1,3}$/u.test(word.trim()) ? wordRegex(upper, true) : wordRegex(word, false);
}

interface Compiled { tag: number; re: RegExp; team: boolean }
interface Hit { tag: number; start: number; end: number; team: boolean }

const normWord = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The other tag (built-in or team-made) that already has `word`, if any: the team's word wins there now. */
export function tagOwningWord(defs: readonly TagDef[], tag: string, word: string): string | null {
  const w = normWord(word);
  const t = normTagName(tag).toLowerCase();
  return defs.find((d) => d.tag.toLowerCase() !== t && [...d.words, ...d.custom].some((x) => normWord(x) === w))?.tag ?? null;
}

const tagIndex = (name: string) => SCOPE_TAGS.findIndex((t) => t.tag === name);
const RADIOS = tagIndex('Radios');
const WIFI = tagIndex('Wi-Fi');
/** Services, not equipment: on a price-terms line ("installation, shipping and taxes") they are not scope. */
const SERVICE_TAGS: ReadonlySet<number> = new Set([tagIndex('Installation'), tagIndex('Licensing')]);
const CHARGES_LINE = /\b(?:taxes|fees|shipping|freight|charges)\b/i;

/** Every tag hit in one line: stop-phrases blanked, overlapping hits keep the longest (a tie: the team's word). */
function lineHits(text: string, compiled: Compiled[]): Hit[] {
  if (HEADER_ROW.test(text)) return [];
  let t = text.replace(QUESTION_CELL, (m) => ' '.repeat(m.length));
  for (const re of STOP_RES) t = t.replace(re, (m) => ' '.repeat(m.length));
  const all: Hit[] = [];
  for (const { tag, re, team } of compiled) for (const m of t.matchAll(re)) all.push({ tag, start: m.index!, end: m.index! + m[0].length, team });
  all.sort((a, b) => (b.end - b.start) - (a.end - a.start) || Number(b.team) - Number(a.team) || a.start - b.start);
  const kept: Hit[] = [];
  for (const h of all) if (!kept.some((k) => h.start < k.end && k.start < h.end)) kept.push(h);
  const wifi = kept.some((k) => k.tag === WIFI);
  const charges = CHARGES_LINE.test(t);
  return kept.filter((k) =>
    !(wifi && k.tag === RADIOS) // "radio" next to Wi-Fi words is an access point's radio
    && !(charges && SERVICE_TAGS.has(k.tag)));
}

export interface ScopeTagResult {
  /** At most 5, most hits first (ties: dictionary order). */
  tags: string[];
  /** The first line that hit one of the tags (for the source dot when there is no summary). */
  first: Line | null;
}

/**
 * Tags for the document: a tag counts with 2+ hits anywhere (1+ in a short document; Installation / Licensing 3+),
 * or 1+ inside the scope section. Outside the section, a tag with under a tenth of the top tag's hits is dropped
 * (`section`: line indexes [start, end) of the cleaned lines).
 */
export function scopeTags(input: Line[], learned: readonly LearnedLabel[], section: { start: number; end: number } | null): ScopeTagResult {
  const lines = cleanLines(input);
  const defs = scopeTagDefs(learned);
  const compiled: Compiled[] = defs.flatMap((d, tag) => [
    ...d.words.map((w) => ({ tag, re: wordRegex(w), team: false })),
    ...d.custom.map((w) => ({ tag, re: teamWordRegex(w), team: true })),
  ]);
  const total = defs.map(() => 0);
  const inSection = defs.map(() => 0);
  const firstLine: (number | null)[] = defs.map(() => null);
  lines.forEach((l, i) => {
    for (const h of lineHits(l.text, compiled)) {
      total[h.tag]++;
      if (section && i >= section.start && i < section.end) inSection[h.tag]++;
      firstLine[h.tag] ??= i;
    }
  });
  const need = (i: number) => (SERVICE_TAGS.has(i) ? SERVICE_MIN_HITS : lines.length < SHORT_DOC_LINES ? 1 : 2);
  const top = Math.max(0, ...total);
  const counted = defs.map((_, i) => i)
    .filter((i) => inSection[i] >= 1 || (total[i] >= need(i) && total[i] >= MIN_SHARE_OF_TOP * top))
    .sort((a, b) => total[b] - total[a] || a - b)
    .slice(0, MAX_TAGS);
  const firstIdx = counted.length ? Math.min(...counted.map((i) => firstLine[i]!)) : null;
  return { tags: counted.map((i) => defs[i].tag), first: firstIdx === null ? null : lines[firstIdx] };
}
