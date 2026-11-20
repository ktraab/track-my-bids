import { describe, it, expect } from 'vitest';
import { checkTagWord, SCOPE_TAGS, scopeTagDefs, scopeTags, tagOwningWord } from './scopeTags';
import type { Line } from './extract';

const page1 = (...texts: string[]): Line[] => texts.map((text) => ({ text, page: 1 }));
const tags = (lines: Line[], section: { start: number; end: number } | null = null, learned = []) => scopeTags(lines, learned, section).tags;

describe('SCOPE_TAGS', () => {
  it('has the spec dictionary in order', () => {
    expect(SCOPE_TAGS.map((t) => t.tag)).toEqual([
      'Networking', 'Wi-Fi', 'Cabling', 'Power / UPS', 'Racks', 'Computers', 'Tablets', 'Displays', 'Audio / Video',
      'Printing', 'Radios', 'Storage', 'Servers', 'Security', 'Licensing', 'Installation',
    ]);
  });
});

describe('scopeTags', () => {
  it('counts a tag with 2+ hits anywhere, plurals and any case', () => {
    expect(tags(page1('Provide 24 network Switches for the high school.', 'Each switch must be managed.'))).toEqual(['Networking']);
  });

  it('one hit outside the scope section is not enough in a long document', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('The vendor may bring a laptop to the meeting.', ...filler))).toEqual([]);
  });

  it('one hit is enough in a short document (under 60 lines)', () => {
    const filler = Array.from({ length: 58 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('Quote two laptops with cases.', ...filler))).toEqual(['Computers']);
  });

  it('one hit inside the scope section is enough', () => {
    const lines = page1('Scope of Work', 'Furnish one projector for the board room.', 'General Terms');
    expect(tags(lines, { start: 1, end: 2 })).toEqual(['Displays']);
  });

  it('short tokens count only in capitals', () => {
    expect(tags(page1('Two UPS units and one PDU.', 'Replace the UPS batteries.'))).toEqual(['Power / UPS']);
    expect(tags(page1('Ship ups and downs.', 'Shipping by ups ground is fine.'))).toEqual([]);
    expect(tags(page1('New APs in the gym.', 'Mount each AP on the ceiling.'))).toEqual(['Wi-Fi']);
  });

  it('"two-way" also matches "2-way"', () => {
    expect(tags(page1('Portable 2-Way Radio, model A', '2-way radios with chargers'))).toEqual(['Radios']);
  });

  it('knows Wi-Fi / WLAN, Cat5e and cabling, interactive boards and webcams', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    const long = (...t: string[]) => page1(...t, ...filler);
    expect(tags(long('Wi-Fi in the gym', 'WiFi survey', 'WLAN controllers'))).toEqual(['Wi-Fi']);
    expect(tags(long('Cat5e patch cords', 'new cabling for room 4'))).toEqual(['Cabling']);
    expect(tags(long('Interactive whiteboards for classrooms', 'One smart board in the library'))).toEqual(['Displays']);
    expect(tags(long('Twenty webcams', 'webcam mounts'))).toEqual(['Audio / Video']);
    expect(tags(long('Clean the whiteboard', 'Power cable for each unit', 'a whiteboard marker', 'cable ties'))).toEqual([]);
  });

  it('"radio" is Radios, but not dual/tri/quad radio, radio frequency/button/station/advertising, or on a Wi-Fi line', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    const long = (...t: string[]) => page1(...t, ...filler);
    expect(tags(long('Portable radios for staff', 'radio chargers'))).toEqual(['Radios']);
    expect(tags(long('Tri-radio design', 'quad radio', 'Radio frequency survey', 'radio buttons', 'radio station ads', 'radio advertising'))).toEqual([]);
    expect(tags(long('Wireless radio 802.11ax', 'Each wireless unit has a second radio'))).toEqual(['Wi-Fi']);
  });

  it('contract boilerplate does not count (rack mount, labor clauses, prevailing wage, black ink, Enclosure A)', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1(
      'Rack mount or rackmount kit', 'Rack/tower form factor', 'Labor disputes delay delivery', 'Secretary of Labor rules', 'Labor relations board',
      'Labor statistics index', 'Local labor and project labor agreements', 'A labor agreement applies', 'Prevailing wage rates', 'Sign in black ink',
      'See Enclosure A', "Governor's cabinet order", 'Labor is billed hourly', 'labor rates', ...filler,
    ))).toEqual([]);
  });

  it('Installation and Licensing words on a taxes / fees / shipping / freight / charges line do not count', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('Prices include installation, shipping and taxes.', 'License fees are extra.', 'Installation charges apply', 'Freight and installation', ...filler))).toEqual([]);
    expect(tags(page1('Installation of the units.', 'Installation on site.', 'Installation by noon.', ...filler))).toEqual(['Installation']);
  });

  it('laptop spec parts (integrated / built-in camera, dual or external monitors) are not Audio / Video or Displays', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1(
      'Integrated webcam', 'integrated web camera and integrated microphones', 'Built-in camera', 'built in speakers', 'Integrated speakers',
      'Supports dual monitors', 'one external monitor', ...filler,
    ))).toEqual([]);
  });

  it('"monitor" as a verb is not Displays', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('The vendor shall monitor progress', 'Staff will monitor the site', 'to monitor usage', 'Track and monitor uptime', 'Monitor and report weekly', ...filler))).toEqual([]);
    expect(tags(page1('Twenty 24-inch monitors', 'Monitor arms', ...filler))).toEqual(['Displays']);
  });

  it('UPS the carrier is not Power / UPS', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('Ship via UPS', 'UPS or FedEx accepted', 'FedEx or UPS', 'UPS, FedEx, or USPS', 'UPS Ground only', 'UPS tracking numbers', 'the UPS Store', 'UPS Freight', ...filler))).toEqual([]);
    expect(tags(page1('Two UPS units', 'UPS batteries', ...filler))).toEqual(['Power / UPS']);
  });

  it('Installation and Licensing need 3 hits (or 1 in the scope section), even in a short document', () => {
    const filler = Array.from({ length: 60 }, (_, k) => `General term number ${k + 1} applies.`);
    expect(tags(page1('Installation of the units.', 'Software license terms.', 'Installation on site.', 'A license for each.', ...filler))).toEqual([]);
    expect(tags(page1('Installation of the units.', 'One license.'))).toEqual([]);
    expect(tags(page1('Scope of Work', 'Installation of the units.', 'Terms'), { start: 1, end: 2 })).toEqual(['Installation']);
    expect(tags(page1('license', 'license', 'license', ...filler))).toEqual(['Licensing']);
  });

  it('drops a tag with under a tenth of the top tag\'s hits, unless it hits in the scope section', () => {
    const many = Array.from({ length: 30 }, (_, k) => `Laptop model ${k + 1}`);
    expect(tags(page1(...many, 'printer', 'printer', 'Chromebook', 'Chromebook', 'printer'))).toEqual(['Computers']);
    expect(tags(page1(...many, 'printer', 'printer', 'printer', 'printer'))).toEqual(['Computers', 'Printing']);
    expect(tags(page1('Scope of Work', 'One printer.', ...many, 'printer'), { start: 1, end: 2 })).toEqual(['Computers', 'Printing']);
  });

  it('matches whole words only', () => {
    expect(tags(page1('The approach is explained.', 'Switchboard operators and routing slips.', 'Printers', 'printer'))).toEqual(['Printing']);
  });

  it('stop-phrases never count', () => {
    expect(tags(page1('Vendor must hold a business license.', "A contractor's license is required.", 'License to do business in the state.'))).toEqual([]);
    expect(tags(page1('Submit camera-ready artwork.', 'Camera-ready copy is due later.'))).toEqual([]);
    expect(tags(page1('Vendors must hold business licenses.', 'Professional licenses are required.', 'Labor laws apply.', 'Labor codes apply.'))).toEqual([]);
  });

  it('orders by hits (ties in dictionary order) and keeps at most 5', () => {
    const lines = page1(
      'laptop laptop laptop', 'iPad iPad', 'printer printer', 'toner toner', 'server server', 'firewall router',
      'access point wireless', 'Cat6 fiber',
    );
    expect(tags(lines)).toEqual(['Printing', 'Computers', 'Networking', 'Wi-Fi', 'Cabling']);
  });

  it('a longer phrase wins over a shorter one inside it', () => {
    // "camera system" is Security only, not also Audio / Video.
    expect(tags(page1('New camera system for the lobby.', 'The camera system needs 8 channels.'))).toEqual(['Security']);
  });

  it('team words extend a built-in tag or add a new one', () => {
    const learned = [
      { field: 'scope_tag:Networking', phrase: 'juniper', hits: 1 },
      { field: 'scope_tag:Furniture', phrase: 'student desk', hits: 1 },
    ];
    expect(scopeTags(page1('Juniper EX4100 x2', 'Juniper support', '30 student desks', 'Student desk chairs'), learned, null).tags)
      .toEqual(['Networking', 'Furniture']);
    const defs = scopeTagDefs(learned);
    expect(defs.find((d) => d.tag === 'Networking')!.custom).toEqual(['juniper']);
    expect(defs.at(-1)).toMatchObject({ tag: 'Furniture', builtIn: false, words: [], custom: ['student desk'] });
  });

  it('a team word wins a tie with a built-in word', () => {
    const learned = [{ field: 'scope_tag:Battery', phrase: 'ups', hits: 1 }];
    expect(scopeTags(page1('Two UPS units', 'Replace the UPS batteries.'), learned, null).tags).toEqual(['Battery']);
  });

  it('a short team word, or one the dictionary keeps to capitals, counts only in capitals', () => {
    const ups = [{ field: 'scope_tag:Battery', phrase: 'ups', hits: 1 }];
    expect(scopeTags(page1('Ship ups and downs.', 'Shipping by ups ground is fine.'), ups, null).tags).toEqual([]);
    const kvm = [{ field: 'scope_tag:Video', phrase: 'kvm', hits: 1 }];
    expect(scopeTags(page1('Two KVM units', 'KVM extenders'), kvm, null).tags).toEqual(['Video']);
    expect(scopeTags(page1('the kvm word', 'a kvm here'), kvm, null).tags).toEqual([]);
    const long = [{ field: 'scope_tag:Furniture', phrase: 'student desk', hits: 1 }];
    expect(scopeTags(page1('STUDENT DESKS', 'student desk'), long, null).tags).toEqual(['Furniture']);
  });

  it('tagOwningWord: another tag that already has the word', () => {
    const learned = [{ field: 'scope_tag:Furniture', phrase: 'student desk', hits: 1 }];
    expect(tagOwningWord(scopeTagDefs(learned), 'Networking', 'Access Point')).toBe('Wi-Fi');
    expect(tagOwningWord(scopeTagDefs(learned), 'Networking', ' student   desk ')).toBe('Furniture');
    expect(tagOwningWord(scopeTagDefs(learned), 'Wi-Fi', 'access point')).toBeNull();
    expect(tagOwningWord(scopeTagDefs(learned), 'Networking', 'juniper')).toBeNull();
  });

  it('a team word for a tag spelled in another case joins that tag', () => {
    const defs = scopeTagDefs([{ field: 'scope_tag:wi-fi', phrase: 'hotspot', hits: 1 }]);
    expect(defs.find((d) => d.tag === 'Wi-Fi')!.custom).toEqual(['hotspot']);
    expect(defs).toHaveLength(SCOPE_TAGS.length);
  });

  it('gives the first line that hit a counted tag', () => {
    const r = scopeTags([{ text: 'Intro', page: 1 }, { text: 'Two Chromebooks', page: 2 }, { text: 'One Chromebook cart', page: 3 }], [], null);
    expect(r.tags).toEqual(['Computers']);
    expect(r.first).toEqual({ text: 'Two Chromebooks', page: 2 });
  });
});

describe('checkTagWord', () => {
  it('normalises whitespace in the tag name and word', () => {
    expect(checkTagWord('  Student   Furniture ', ' student \t desk ')).toEqual({ tag: 'Student Furniture', word: 'student desk' });
  });

  it('rejects "·", line breaks, words without 2 letters/digits and tag names over 30 characters', () => {
    expect(checkTagWord('Furniture', 'desk · chair')).toHaveProperty('error');
    expect(checkTagWord('Furn · iture', 'desk')).toHaveProperty('error');
    expect(checkTagWord('Furniture', 'desk\nchair')).toHaveProperty('error');
    expect(checkTagWord('Furni\nture', 'desk')).toHaveProperty('error');
    expect(checkTagWord('Furniture', 'a')).toHaveProperty('error');
    expect(checkTagWord('Furniture', '--')).toHaveProperty('error');
    expect(checkTagWord('Furniture', '')).toHaveProperty('error');
    expect(checkTagWord('', 'desk')).toHaveProperty('error');
    expect(checkTagWord('A'.repeat(31), 'desk')).toHaveProperty('error');
    expect(checkTagWord('A'.repeat(30), 'k9')).toEqual({ tag: 'A'.repeat(30), word: 'k9' });
  });
});
