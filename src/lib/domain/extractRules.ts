import type { AgencyType, Method } from './types';

/** Date fields: each becomes a milestone of the same type (allowable_contract included). */
export const DATE_FIELDS = ['due', 'pre_bid', 'qa_deadline', 'site_walk', 'allowable_contract'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

/** Every field the importer can suggest. */
export const EXTRACT_FIELDS = [
  ...DATE_FIELDS,
  'bid_number', 'title', 'agency_name', 'agency_type', 'submission_method', 'portal_name', 'portal_url',
  'delivery_address', 'copies_required', 'notarize_required', 'est_value', 'scope', 'timezone',
  'erate', 'erate_470_number', 'erate_funding_year', 'erate_category',
] as const;
export type ExtractField = (typeof EXTRACT_FIELDS)[number];

/** How the value after a label is read. */
export type ValueKind = 'date' | 'id' | 'text' | 'money' | 'nine' | 'year';

/** Fields read as "label phrase → value". Only these learn new label phrases (scope learns its section heading instead). */
export const LABEL_FIELDS = {
  due: 'date', pre_bid: 'date', qa_deadline: 'date', site_walk: 'date', allowable_contract: 'date',
  bid_number: 'id', title: 'text', agency_name: 'text', delivery_address: 'text', est_value: 'money',
  erate_470_number: 'nine', erate_funding_year: 'year',
} as const satisfies Partial<Record<ExtractField, ValueKind>>;
export type LabelField = keyof typeof LABEL_FIELDS;
export const isLabelField = (f: string): f is LabelField => Object.hasOwn(LABEL_FIELDS, f);

/** Built-in label phrases (lowercase; "-" also matches a space or nothing; a leading "^" = only at the start of a line or cell). */
export const BUILT_IN_LABELS: Record<LabelField, readonly string[]> = {
  due: [
    'proposals due', 'proposals must be received', 'proposal due date', 'bids due', 'bid due date', 'bids must be received',
    'due date', 'bid opening', 'opening date', 'closing date', 'submission deadline', 'deadline for submission',
    'responses must be received by', 'responses due', 'response due date', 'quotes due', 'submittals due',
    'deadline for submittal', 'submittal deadline', 'due no later than', 'quote not later than', 'bid closes', 'solicitation closes',
    '^end date', '^current end date',
  ],
  pre_bid: [
    'pre-bid conference', 'pre-bid meeting', 'pre-proposal conference', 'pre-proposal meeting',
    'pre-submittal conference', 'pre-submittal meeting', 'pre-bid',
  ],
  qa_deadline: [
    'questions due', 'deadline for questions', 'deadline for inquiries', 'last day for questions',
    'questions must be received', 'deadline for written questions', 'inquiries due', 'question deadline',
    'deadline to submit questions', 'requests for information', 'rfi deadline', 'deadline for rfi', 'inquiries must be',
  ],
  site_walk: ['site visit', 'site walk', 'walk-through', 'site inspection', 'job walk', 'site tour'],
  allowable_contract: ['allowable contract date', 'acd'],
  bid_number: [
    'bid no', 'bid number', 'bid #', 'rfp no', 'rfp #', 'rfp number', 'rfq no', 'rfq #', 'rfq number',
    'ifb no', 'ifb #', 'ifb number', 'itb no', 'itb #', 'solicitation number', 'solicitation no', 'solicitation #',
    'proposal no', 'proposal number', 'request for proposals no', 'invitation for bid no', 'invitation to bid no',
    'project number', 'contract number', 'rfq id', 'rfp id', 'bid id', 'solicitation id', 'contract index no',
    'bid solicitation', 'ref. no', 'ref no', '^reference no', '^reference number',
  ],
  title: ['project title', 'project name', 'solicitation title', 'bid title', 'rfp title', '^title', 'contract name'],
  agency_name: ['^agency', '^organization', '^school name', '^entity name', '^district name', '^applicant name'],
  delivery_address: [
    'deliver to', 'delivered to', 'mail to', 'address proposals to', 'submit proposals to', 'submit bids to',
    'delivery address', 'hand deliver to', 'sealed bids to', 'sealed proposals to',
  ],
  est_value: ['estimated value', 'estimated budget', 'estimated cost', 'budget', 'not to exceed', 'estimated contract value'],
  erate_470_number: ['form 470 application number', '470 application number', 'form 470 number', 'form 470', '470 #', '470#', '470 number', 'application number'],
  erate_funding_year: ['funding year'],
};

/** Field names as people say them (Settings → Document import). */
export const FIELD_NAMES: Record<ExtractField, string> = {
  due: 'Due date', pre_bid: 'Pre-bid meeting', qa_deadline: 'Q&A deadline', site_walk: 'Site walk',
  allowable_contract: 'Allowable contract date', bid_number: 'Bid #', title: 'Title', agency_name: 'Agency',
  agency_type: 'Agency type', submission_method: 'Submission', portal_name: 'Portal name', portal_url: 'Portal URL',
  delivery_address: 'Delivery address', copies_required: 'Copies required', notarize_required: 'Notarization',
  est_value: 'Est. value', scope: 'Scope', timezone: 'Timezone', erate: 'E-Rate', erate_470_number: 'Form 470 #',
  erate_funding_year: 'Funding year', erate_category: 'E-Rate category',
};

/** A page-1/2 line naming the agency. */
export const AGENCY_LINE = /\b(?:independent school district|school district|public schools|unified school|isd|board of education|school board|community college|university|college|county of|city of|state of|town of|village of|township of|department of|commonwealth of|library|academy|catholic school|housing authority|transit authority|port authority|office of education)\b/i;
const AGENCY_TYPE_WORDS = ['independent school district', 'unified school district', 'school district', 'public schools', 'board of education',
  'community college', 'university', 'college', 'office of education', 'housing authority'];
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
/** "School District" / "SCHOOL DISTRICT" (Title Case or capitals only, so a sentence's "the school district" does not count). */
const cased = (phrase: string) => phrase.split(' ')
  .map((w) => (/^(?:of|the|and)$/.test(w) ? `(?:${w}|${cap(w)}|${w.toUpperCase()})` : `(?:${cap(w)}|${w.toUpperCase()})`)).join('\\s+');
/**
 * An agency name at the start of a longer line (an address follows): "Harbor Falls School District #12 400 Main St…".
 * Groups: 1 = the name, 2 = a number suffix ("#12", "No. 4", " 400"), 3 = that number when bare (it may be a street number).
 */
export const AGENCY_HEAD = new RegExp(String.raw`^([A-Z][\w.'’-]*(?:\s+(?:of|the|and|OF|THE|AND|[A-Z][\w.'’-]*)){0,6}?\s+(?:${AGENCY_TYPE_WORDS.map(cased).join('|')}))(\s*(?:No\.?|NO\.?|no\.?|#)\s*\d{1,4}\b|\s+(\d{1,4})\b)?`);
/** A street after a bare number: "… District 400 Main Street" (the number is the address, not the district's). */
export const STREET_AFTER = /^\s+(?:[A-Za-z0-9.'’-]+\s+){0,3}?(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|highway|hwy|parkway|pkwy|court|ct|place|pl|circle|cir)\b/i;
/** A heading that is a notice or a request, not the agency: "Notice To Bidders …", "Request For Proposals For …". */
export const AGENCY_HEAD_NOT = /^(?:notice|request|instructions?|the|invitation)\b/i;
/** Sentence words in an ALL-CAPS line: "THE BIDDER SHALL NOTIFY THE SCHOOL DISTRICT IN WRITING". */
export const CAPS_SENTENCE = /\b(?:SHALL|MUST|WILL(?!\s+COUNTY)|NOTIFY|WRITING|SHOULD|PLEASE|SUBMIT|BIDDERS?|VENDORS?)\b/;
/** "the City of Harbor" inside a sentence (Title Case place name only). */
export const AGENCY_IN_PROSE = /\b(?:City|County|Town|Village|Township) of (?!(?:Residence|Origin|Birth|Business|License|Incorporation)\b)(?:[A-Z][a-z]+)(?: [A-Z][a-z]+)?\b/g;
/** "Harbor County", "Riverside City" (proper-noun case only, so prose like "the County shall" does not count). */
export const AGENCY_PROPER = /\b[A-Z][A-Za-z.'-]+\s+(?:County|City|Parish|COUNTY|CITY|PARISH)\b/;
/** A heading split over two lines: "CITY OF" / "Springfield". */
export const AGENCY_SPLIT = /\b(?:city|county|state|town|village|township|commonwealth) of$/i;

const US_STATES = 'alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming';

/** Agency type from the agency's name; first match wins (federal and state cues before the generic city/school words). */
export const AGENCY_TYPE_RULES: readonly [AgencyType, RegExp][] = [
  ['federal', /\b(?:federal(?!\s+way\b)|united states|department of defense|army|navy|air force|usace|gsa)\b|\bu\.s\.(?=\s|$)/i],
  ['state', new RegExp(String.raw`\b(?:${US_STATES})\s+(?:department|dept)\b`, 'i')],
  ['k12', /\b(?:school dist(?:rict)?|public schools|isd|unified school|board of education|school board|academy|elementary|charter school|k-12|usd)\b/i],
  ['higher_ed', /\b(?:university|college|community college|institute of technology)\b/i],
  ['county', /\b(?:county|parish|borough)\b/i],
  ['city', /\b(?:city|town|village|township|municipal)\b/i],
  ['state', /\b(?:state of|commonwealth of|state department|state university system)\b/i],
];

/** Phrases that point at a submission method. */
export const METHOD_RULES: readonly [Method, RegExp][] = [
  ['sealed', /\bsealed\s+(?:bids?|proposals?|envelopes?|packages?|responses?)\b|\bhard\s*copy\b|\bhand[\s-]deliver/i],
  ['online', /\bsubmitted\s+(?:electronically|online)\b|\belectronic(?:ally)?\s+submi|\bonline\s+(?:submission|portal)\b|\bupload(?:ed)?\b|\bvia\s+the\s+portal\b/i],
  ['email', /\b(?:via|by)\s+e-?mail\b|\be-?mailed\s+to\b|\bsubmit(?:ted)?\s+(?:by|via)\s+e-?mail\b/i],
];

/** Known e-bidding portals: display name + how they appear in text or URLs. */
export const PORTALS: readonly { name: string; text: RegExp; host: RegExp }[] = [
  { name: 'BidNet Direct', text: /\bbidnet(?:\s+direct)?\b/i, host: /bidnetdirect\.com|bidnet\.com/i },
  { name: 'Bonfire', text: /\bbonfire\b/i, host: /bonfirehub\.com/i },
  { name: 'DemandStar', text: /\bdemandstar\b/i, host: /demandstar\.com/i },
  { name: 'PlanetBids', text: /\bplanet\s?bids\b/i, host: /planetbids\.com/i },
  { name: 'OpenGov', text: /\bopengov\b/i, host: /opengov\.com/i },
  { name: 'Periscope', text: /\bperiscope\b/i, host: /periscopeholdings\.com|bidsync\.com/i },
  { name: 'BidSync', text: /\bbidsync\b/i, host: /bidsync\.com/i },
  { name: 'IonWave', text: /\bion\s?wave\b/i, host: /ionwave\.net/i },
  { name: 'Jaggaer', text: /\bjaggaer\b/i, host: /jaggaer\.com/i },
  { name: 'Euna Procurement', text: /\beuna\b/i, host: /eunasolutions\.com/i },
  { name: 'Negometrix', text: /\bnegometrix\b/i, host: /negometrix\.com/i },
  { name: 'eMaryland Marketplace', text: /\bemma\b|\bemaryland marketplace\b/i, host: /emma\.maryland\.gov/i },
];

/** Words on a line that make a URL there likely the submission portal. */
export const PORTAL_CUE = /\bportal\b|\bsubmi(?:t|ssion)|\belectronic|\bupload|\bonline\b|\bregister\b/i;

/** Timezone mentions → IANA zone. Long names are case-insensitive; abbreviations must be upper case. */
export const TIMEZONE_RULES: readonly [string, RegExp][] = [
  ['America/New_York', /\beastern\s+(?:standard\s+|daylight\s+|prevailing\s+)?time\b/i],
  ['America/Chicago', /\bcentral\s+(?:standard\s+|daylight\s+|prevailing\s+)?time\b/i],
  ['America/Denver', /\bmountain\s+(?:standard\s+|daylight\s+|prevailing\s+)?time\b/i],
  ['America/Los_Angeles', /\bpacific\s+(?:standard\s+|daylight\s+|prevailing\s+)?time\b/i],
];
export const TIMEZONE_ABBR: readonly [string, RegExp][] = [
  ['America/New_York', /\bE[SD]T\b/],
  ['America/Chicago', /\bC[SD]T\b/],
  ['America/Denver', /\bM[SD]T\b/],
  ['America/Los_Angeles', /\bP[SD]T\b/],
];

/** "One (1) original and five (5) copies" / "5 copies" / "five copies". */
export const COPIES = /\b(?:(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*)?(?:\((\d{1,2})\)|(\d{1,2}))?\s+(?:additional\s+|hard\s+|paper\s+|printed\s+|bound\s+|identical\s+)*cop(?:y|ies)\b/i;
export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
export const NOTARIZE = /\bnotariz(?:e|ed|ation)\b/i;

/** The pre-bid / site walk is required (unless the line says otherwise). */
export const MANDATORY = /\bmandatory\b|\brequired\b/i;
export const NOT_MANDATORY = /\bnon-?mandatory\b|\bnot\s+(?:mandatory|required)\b|\boptional\b/i;

/** A solicitation header line (it starts with "Request for…", "Invitation for Bids", "RFP"…); the title often follows it. */
export const SOLICITATION_LINE = /^(?:[A-Z0-9#.:-]+\s+){0,2}(?:request\s+for\s+(?:proposals?|quotations?|qualifications|bids?)|invitation\s+(?:to|for)\s+bids?|rfp|ifb|itb|rfq|rfb)\b/i;
/** A line that is itself a label ("Buyer | …", "Due date: …"), never a title. */
export const NOT_TITLE = /^(?:buyer|contact|date|due|deadline|phone|e-?mail|issued|issue date|opening|closing|page|addendum|acknowledge?ment)\b|:\s*$|_{3,}/i;
/** Label fields only trusted near the front of the document (else prose like "agency purchases…" matches). */
export const LABEL_MAX_PAGE: Partial<Record<LabelField, number>> = { agency_name: 2, title: 3 };
/** Fallback bid number anywhere on pages 1–2: "RFP 26-114", "IFB #2026-07", "RFQ-2026-10442" (not inside a file name: "RFP 2027_03_Final"). */
export const BID_NUMBER_PATTERN = /\b(RFP|RFQ|IFB|ITB|RFB|RFSQ)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9./-]*\d[A-Z0-9./-]*)(?![\w])/i;
/** "Bid #27-131", "Bid: QQ #101526" (a portal's bid type code before the number). */
export const BID_HASH_PATTERN = /\bbid\s*:?\s*(?:[A-Z]{2,4}\s*)?#\s*([A-Z0-9][A-Z0-9./-]*\d[A-Z0-9./-]*)(?![\w])/i;

// E-Rate (USAC / FCC Form 470)
export const ERATE = /\be-?rate\b|\bfcc\s+form\s+470\b|\bform\s+470\b|\busac\b|\bbilled\s+entity\s+number\b/i;
export const FUNDING_YEAR = /\b(?:funding\s+year|fy)\s*:?\s*(20\d{2})\b/i;
const CAT1_WORDS = /\bcategory\s*(?:1|one|i)\b(?!\s*(?:and|&|\/)\s*(?:2|two|ii)\b)/i;
const CAT2_WORDS = /\bcategory\s*(?:2|two|ii)\b|\bcategor(?:y|ies)\s*(?:1|one|i)\s*(?:and|&|\/)\s*(?:2|two|ii)\b/i;
/** "Category 1" in any case; the "C1" / "C2" codes only in capitals (so "c1" in a part number does not count). */
export const CATEGORY_1 = { test: (s: string) => CAT1_WORDS.test(s) || CAT1_SERVICES.test(s) || /\bC1\b/.test(s) };
export const CATEGORY_2 = { test: (s: string) => CAT2_WORDS.test(s) || CAT2_SERVICES.test(s) || /\bC2\b/.test(s) };
/** Form 470 service types: Category 1 = data transmission / internet access; Category 2 = internal connections, MIBS, BMIC. */
const CAT1_SERVICES = /\bdata transmission and\/or\b|\bleased lit fiber\b|\bdark fiber\b/i;
const CAT2_SERVICES = /\binternal connections\b|\bmanaged internal broadband\b|\bbasic maintenance of internal\b/i;
/** Form 470 section headings, present even when the section is empty. */
export const FORM_470_SECTION = /^category (?:one|two) service requests$/i;
/** "does not include Category 1 services": a negated clause says nothing about the category requested. */
export const NEGATED_CLAUSE = /\b(?:does|do|will|shall)\s+not\s+include\b[^.;]*/gi;
/** Category cues only count on the first pages. */
export const CATEGORY_MAX_PAGE = 5;
/** Form 470 certified / posted date: the allowable contract date is 28 days later. */
export const CERTIFIED_LABELS = ['certified timestamp', 'certified date', 'certification date', 'date certified', 'posting date', 'posted date', 'date posted'] as const;
/** Labels too generic to trust without a Form 470 cue (470, USAC, certif…) on the same line or page. */
export const GENERIC_CERTIFIED_LABELS: ReadonlySet<string> = new Set(['posting date', 'posted date', 'date posted']);
export const FORM_470_CUE = /470|usac|certif/i;
export const ACD_DAYS = 28;

export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'its', 'no', 'not', 'of', 'on',
  'or', 'shall', 'should', 'that', 'the', 'their', 'this', 'to', 'was', 'were', 'will', 'with', 'all', 'any', 'must',
  'may', 'can', 'than', 'then', 'into', 'per', 'via',
]);
