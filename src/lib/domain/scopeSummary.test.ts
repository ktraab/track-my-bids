import { describe, it, expect } from 'vitest';
import { cutAtSentence, findScope, firstSentence, form470Summary, isHeadingLike, learnScopeHeading, scopeSection } from './scopeSummary';
import type { Line } from './extract';

const page1 = (...texts: string[]): Line[] => texts.map((text) => ({ text, page: 1 }));
const summary = (lines: Line[], learned: { phrase: string; hits: number }[] = []) => findScope(lines, learned).summary;

const TABLE_470 = [
  'Category Two Service Requests',
  'Service Type | Function | Manufacturer | Manufacturer Entities | Quantity | Unit | Installation | Associated',
  'Other | and Initial | RFPs',
  'Description | Configuration?',
  'Internal Connections | Switches and Necessary | Brandco or equivalent | 2 | Each | Yes | 111111',
  'Software and Licenses',
  'Basic Maintenance of Internal | Switches | Brandco | 1 | 2 | Each | 111111',
  'Connections',
  'Internal Connections | Wireless Access Points and | Brandco or | 12 | Each | Yes | 111111',
  'Necessary Software and | equivalent',
  'Licenses',
  'Internal Connections | Switches and Necessary | Otherco or equivalent | 3 | Each | Yes | 111111',
  'Software and Licenses',
  'Internal Connections | Cabling | No Preference | 1 | 5000 | Feet | Yes | 111111',
  'Description of Other Manufacturers',
];

describe('firstSentence', () => {
  it('does not end at abbreviations, initials or a lowercase / digit continuation', () => {
    expect(firstSentence('Ship to the U.S. Forest office by May. Then install.')).toBe('Ship to the U.S. Forest office by May.');
    expect(firstSentence('Approx. Forty units, e.g. Model AB. Next.')).toBe('Approx. Forty units, e.g. Model AB.');
    expect(firstSentence('Deliver to St. Paul Dept. Of Works, Inc. Today. Next.')).toBe('Deliver to St. Paul Dept. Of Works, Inc. Today.');
    expect(firstSentence('Contact J. Smith about item no. 4 and v. 2. Done.')).toBe('Contact J. Smith about item no. 4 and v. 2.');
    expect(firstSentence('Buy pens. Then paper!')).toBe('Buy pens.');
    expect(firstSentence('No end here')).toBe('No end here');
  });
});

describe('isHeadingLike', () => {
  it('short title-case or capitals lines without a sentence end', () => {
    expect(isHeadingLike('Scope of Work')).toBe(true);
    expect(isHeadingLike('3.2 GENERAL REQUIREMENTS:')).toBe(true);
    expect(isHeadingLike('SPECIFICATIONS FOR')).toBe(true);
    expect(isHeadingLike('Technical Contact')).toBe(true);
  });
  it('not prose, table rows or lines ending mid-phrase', () => {
    expect(isHeadingLike('The district will replace the network core in all buildings.')).toBe(false);
    expect(isHeadingLike('Item | Quantity | Description')).toBe(false);
    expect(isHeadingLike('Harbor Valley School District Board of')).toBe(false);
    expect(isHeadingLike('Trustees.')).toBe(false);
  });
});

describe('form470Summary', () => {
  it('renders the service request table, summing each function, then the narrative', () => {
    const lines = page1(...TABLE_470, 'Narrative', 'The library is replacing its network core. Bids go to the contact below.', 'Technical Contact', 'Robin Example');
    const s = form470Summary(lines);
    expect(s?.text).toBe('Internal Connections: Switches ×5, Wireless Access Points ×12, Cabling 5,000 ft; Basic Maintenance\nThe library is replacing its network core. Bids go to the contact below.');
    expect(s?.sourceLine).toContain('Internal Connections | Switches');
  });

  it('skips empty narratives and headings that follow them', () => {
    const lines = page1('Category One Service Requests', 'Narrative', 'Category Two Service Requests', ...TABLE_470.slice(1, 7), 'Narrative', 'BID SUBMISSION REQUIREMENTS', 'Send bids by email.');
    expect(form470Summary(lines)?.text).toBe('Internal Connections: Switches ×2; Basic Maintenance');
  });

  it('names other service types and ignores continuation lines', () => {
    const lines = page1(
      'Category One Service Requests',
      'Service Type | Function | Function | Minimum | Maximum | Entities | Quantity Unit | Installation | Associated',
      'Data Transmission and/or | Internet Access and | 100 Mbps | 1 Gbps | 1 | 1 | Each | Yes',
      'Internet Access | Data Transmission',
      'Service',
      'Category Two Service Requests',
      'Managed Internal Broadband | Leased Equipment | 1 | 222222',
      'Services',
    );
    expect(form470Summary(lines)?.text).toBe('Data Transmission and/or Internet Access; Managed Internal Broadband Services');
  });

  it('a very long table is cut at a list separator within 500 characters, with no narrative', () => {
    const rows = Array.from({ length: 80 }, (_, k) => `Internal Connections | Gadget Model ${k + 1} | Brandco | ${k + 1} | Each | Yes | 111111`);
    const lines = page1('Category Two Service Requests', ...rows, 'Narrative', 'The campus is upgrading its equipment this summer.', 'Technical Contact');
    const t = form470Summary(lines)!.text;
    expect(t.length).toBeLessThanOrEqual(500);
    expect(t).toMatch(/^Internal Connections: Gadget Model 1 ×1, /);
    expect(t).toMatch(/×\d+…$/);
    expect(t).not.toContain('\n');
  });

  it('leaves out a "see attached" narrative', () => {
    const lines = page1(...TABLE_470.slice(0, 7), 'Narrative', 'See the attached RFP for details.', 'Technical Contact');
    expect(form470Summary(lines)?.text).toBe('Internal Connections: Switches ×2; Basic Maintenance');
  });

  it('null when there is no service request table', () => {
    expect(form470Summary(page1('Scope of Work', 'Replace things.'))).toBeNull();
  });
});

describe('scope section', () => {
  it('takes the lines under a built-in heading until the next heading', () => {
    const lines = page1(
      'Request for Proposals', '1. Scope of Work',
      'The district seeks a vendor to replace core switching and 12 wireless access points at the',
      'main campus. Work includes removal of old equipment.', '2. Proposal Format', 'Proposals must be bound.',
    );
    expect(summary(lines)).toEqual({
      text: 'The district seeks a vendor to replace core switching and 12 wireless access points at the main campus. Work includes removal of old equipment.',
      page: 1, sourceLine: 'The district seeks a vendor to replace core switching and 12 wireless access points at the',
    });
    expect(scopeSection(lines, [])).toEqual({ heading: 1, start: 2, end: 4 });
  });

  it('skips table-of-contents entries (leaders, page numbers, no body)', () => {
    const lines = page1(
      'Table of Contents', 'A. Purpose ........................ 3', 'B. Scope of Services ______ 4', 'C. Insurance 9',
      'A. PURPOSE', 'The county wants new radios for field crews.', 'B. SCOPE OF SERVICES', 'Supply 40 handheld radios and chargers.', 'C. INSURANCE',
    );
    expect(summary(lines)?.text).toBe('Supply 40 handheld radios and chargers.');
  });

  it('a heading ending in a number is not a TOC entry unless the lines next to it look like one', () => {
    const body = 'The district will add forty cable drops in the gym.';
    expect(summary(page1('SCOPE OF WORK – PHASE 2', body, 'Terms'))?.text).toBe(body);
    expect(summary(page1('Scope of Work – Lot 3', body, 'Terms'))?.text).toBe(body);
    expect(summary(page1('Contents', 'Scope of Work 4', 'Proposal Format 6', 'Insurance 9', 'Scope of Work', body, 'Terms'))?.sourceLine).toBe(body);
    expect(scopeSection(page1('Contents', 'Scope of Work 4', 'Proposal Format 6', 'Scope of Work', body), [])?.heading).toBe(3);
  });

  it('prefers higher-ranked headings and accepts "of"/"/" qualifiers and inline text after a colon', () => {
    expect(summary(page1('Background: The city was founded long ago.', 'Scope of Purchase: Twelve laptops with cases.', 'Terms'))?.text)
      .toBe('Twelve laptops with cases.');
    expect(summary(page1('3. SCOPE OF WORK/PURCHASE', 'Furnish one projector.', '4. TERMS'))?.text).toBe('Furnish one projector.');
  });

  it('a bare "Description" heading counts last, and only above a sentence of 8+ words', () => {
    const body = 'The district will buy forty laptops with cases and chargers for students.';
    expect(summary(page1('Description', body, 'Terms'))?.text).toBe(body);
    expect(summary(page1('Description', body, 'Background', 'The town has grown a great deal lately.', 'Terms'))?.text).toBe('The town has grown a great deal lately.');
    expect(summary(page1('Description: Laptop computers for the students in grade four', 'Terms'))).toBeNull();
    expect(summary(page1('Description', 'Item | Qty | Price for the laptops with cases and chargers', 'Terms'))).toBeNull();
    expect(summary(page1('Description', 'Forty laptops with cases.', 'More text follows on this line here.', 'Terms'))).toBeNull();
    expect(summary(page1('Description', 'Laptop Computers', body, 'Terms'))).toBeNull();
  });

  it('a heading that only starts like a scope heading does not count', () => {
    expect(summary(page1('Background Checks', 'All staff must pass a check.', 'Specifications Shall Control', 'In a conflict, specs win.'))).toBeNull();
  });

  it('skips title lines right under the heading and page-number lines in the body', () => {
    const lines = [
      { text: 'SCOPE', page: 2 }, { text: 'SPECIFICATIONS FOR', page: 2 }, { text: 'BATTERY BACKUP REPLACEMENT', page: 2 },
      { text: 'These specifications cover the purchase and installation of', page: 2 }, { text: '7', page: 2 },
      { text: 'battery backup units.', page: 3 }, { text: 'Delivery', page: 3 },
    ];
    expect(summary(lines)).toMatchObject({ text: 'These specifications cover the purchase and installation of battery backup units.', page: 2 });
  });

  it('cuts at a sentence end within 500 characters', () => {
    const sentence = 'This sentence is about forty-five chars long. ';
    const lines = page1('Statement of Work', sentence.repeat(20).trim(), 'Pricing');
    const t = summary(lines)!.text;
    expect(t.length).toBeLessThanOrEqual(500);
    expect(t.endsWith('long.')).toBe(true);
  });

  it('cutAtSentence does not cut after an abbreviation', () => {
    expect(cutAtSentence('Work covers the U.S. Forest office and more text after it', 30)).toBe('Work covers the U.S. Forest…');
  });

  it('cutAtSentence gives nothing when there is no room', () => {
    expect(cutAtSentence('Some words here.', 1)).toBe('');
    expect(cutAtSentence('Some words here.', 0)).toBe('');
    expect(cutAtSentence('Some words here.', -5)).toBe('');
  });

  it('uses a learned scope heading used 2+ times first', () => {
    const lines = page1('Scope of Work', 'The vendor shall do various things as listed.', 'What We Need', 'Two copiers for the front office.', 'Terms');
    expect(summary(lines, [{ phrase: 'what we need', hits: 2 }])?.text).toBe('Two copiers for the front office.');
    expect(findScope(lines, [{ phrase: 'what we need', hits: 2 }]).learnedHeading).toBe('what we need');
  });

  it('a learned scope heading used once ranks after "scope of work" / "scope of services" only', () => {
    const lines = page1('Scope of Work', 'The vendor shall do various things as listed.', 'What We Need', 'Two copiers for the front office.', 'Terms');
    expect(summary(lines, [{ phrase: 'what we need', hits: 1 }])?.text).toBe('The vendor shall do various things as listed.');
    const lower = page1('Specifications', 'Copiers shall print forty pages a minute.', 'What We Need', 'Two copiers for the front office.', 'Terms');
    expect(summary(lower, [{ phrase: 'what we need', hits: 1 }])?.text).toBe('Two copiers for the front office.');
  });

  it('rejoins words split by a hyphen at a line end', () => {
    expect(summary(page1('Purpose', 'Buy E-', 'Rate eligible switches.', 'Terms'))?.text).toBe('Buy E-Rate eligible switches.');
  });

  it('a "see attached" / "refer to" body is not a summary; the next heading is tried', () => {
    expect(summary(page1('Scope of Work', 'Please see the attached specifications document.', 'Specifications', 'Copiers shall print forty pages a minute.', 'Terms'))?.text)
      .toBe('Copiers shall print forty pages a minute.');
    expect(summary(page1('Scope of Work: Refer to Exhibit A for full details.', 'Terms'))).toBeNull();
    const long = 'See below: the vendor shall furnish, install and configure twelve classroom displays with mounts and cabling.';
    expect(summary(page1('Scope of Work', long, 'Terms'))?.text).toBe(long);
  });

  it('null when nothing matches', () => {
    expect(findScope(page1('Hello', 'Nothing here.'), [])).toEqual({ summary: null, section: null });
  });
});

describe('learnScopeHeading', () => {
  const doc = page1(
    'Invitation to Bid', 'Our Needs', 'The town will buy six patrol laptops and docks for the', 'police department.', 'Terms',
  );

  it('learns the nearest short heading above the first sentence of the saved scope', () => {
    expect(learnScopeHeading(doc, 'Computers\nThe town will buy six patrol laptops and docks for the police department. Extra text.', [])).toBe('our needs');
  });

  it('skips a tag line of three or more tags, built-in or the team\'s', () => {
    const saved = 'Networking · Wi-Fi · Cabling\nThe town will buy six patrol laptops and docks for the police department.';
    expect(learnScopeHeading(doc, saved, [])).toBe('our needs');
    const team = [{ field: 'scope_tag:Furniture', phrase: 'student desk', hits: 1 }];
    expect(learnScopeHeading(doc, `Furniture · Computers · Tablets · Displays\n${saved.split('\n')[1]}`, [], team)).toBe('our needs');
  });

  it('the sentence line needs a sentence end or six words', () => {
    const lines = page1('Invitation to Bid', 'Patrol Laptop Docking Stations Here', 'Our Needs', 'The town will buy six patrol laptops and docks for the police department.');
    expect(learnScopeHeading(lines, 'Patrol Laptop Docking Stations Here\nThe town will buy six patrol laptops and docks for the police department.', [])).toBe('our needs');
  });

  it('the first sentence may contain abbreviations', () => {
    const lines = page1('Invitation to Bid', 'Our Needs', 'The U.S. Forest office will buy six laptops and docks.', 'Terms');
    expect(learnScopeHeading(lines, 'The U.S. Forest office will buy six laptops and docks.', [])).toBe('our needs');
  });

  it('null when the sentence is not in the document, or the heading is already known', () => {
    expect(learnScopeHeading(doc, 'Something we typed ourselves.', [])).toBeNull();
    expect(learnScopeHeading(doc, 'The town will buy six patrol laptops and docks for the police department.', ['our needs'])).toBeNull();
  });

  it('looks only a few lines up', () => {
    const lines = page1('Our Needs', 'Line one here', 'line two here', 'line three here', 'line four here', 'line five here', 'line six here', 'line seven here',
      'The town will buy six patrol laptops and docks for the police department.');
    expect(learnScopeHeading(lines, 'The town will buy six patrol laptops and docks for the police department.', [])).toBeNull();
  });

  it('skips running headers (on 2+ pages) and RFP / bid / exhibit / section / page headings', () => {
    const sentence = 'The town will buy six patrol laptops and docks for the police department.';
    const lines: Line[] = [
      { text: 'Harbor Town Schools', page: 1 }, { text: 'Intro text for the bid.', page: 1 },
      { text: 'Our Needs', page: 2 }, { text: 'Harbor Town Schools', page: 2 }, { text: sentence, page: 2 },
    ];
    expect(learnScopeHeading(lines, sentence, [])).toBe('our needs');
    for (const junk of ['RFP 26-14 Laptops', 'Bid Form', 'City of Harbor', 'County of Lake', 'Exhibit B', 'Page Two']) {
      expect(learnScopeHeading(page1(junk, sentence), sentence, []), junk).toBeNull();
    }
    expect(learnScopeHeading(page1('Scope of Work', 'Buy six laptops for the office now.'), 'Buy six laptops for the office now.', [])).toBeNull();
  });

  it('null for a sentence too short to be sure', () => {
    expect(learnScopeHeading(doc, 'Terms', [])).toBeNull();
  });
});
