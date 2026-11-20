import { describe, it, expect } from 'vitest';
import { extract, isEmptySuggestions, labelRegex, type LearnedLabel, type Line } from './extract';
import type { ExtractField } from './extractRules';

const TODAY = '2026-01-15';
const page = (n: number, ...texts: string[]): Line[] => texts.map((text) => ({ text, page: n }));
const pick = (lines: Line[], field: ExtractField, learned: LearnedLabel[] = []) => extract(lines, learned, TODAY).fields[field];
const best = (lines: Line[], field: ExtractField) => pick(lines, field)?.[0];

const RFP: Line[] = [
  ...page(1,
    'Harbor County School District',
    'Request for Proposals No. RFP 26-114',
    'Student Chromebooks',
    'Sealed proposals must be received by Tuesday, March 3, 2026 at 2:00 p.m. Central Time.',
    'Schedule of Events',
    'Event | Date',
    'Pre-Proposal Conference (mandatory) | February 10, 2026 10:00 AM',
    'Deadline for written questions | February 20, 2026',
    'Proposals due | March 3, 2026 2:00 PM',
  ),
  ...page(2,
    'Submit one (1) original and five (5) copies in a sealed envelope to:',
    'Harbor County School District, Purchasing Department, 100 Main St., Harbor, TX 77001',
    'Proposals must be notarized.',
    'Questions shall be directed to:',
    'Jane Doe, Purchasing Agent',
    'jdoe@harbor.k12.tx.us | (555) 201-3344',
  ),
];

describe('extract — dates', () => {
  it('finds the due date from a sentence and a schedule table, best first', () => {
    const due = pick(RFP, 'due')!;
    expect(due[0]).toMatchObject({ value: '2026-03-03T14:00', hasTime: true, page: 1, learned: false });
    expect(due.map((c) => c.value)).toEqual(['2026-03-03T14:00']); // same instant from two lines → one candidate
  });

  it('pre-bid from a table row, marked mandatory', () => {
    expect(best(RFP, 'pre_bid')).toMatchObject({ value: '2026-02-10T10:00', mandatory: true });
  });

  it('Q&A deadline without a time → 17:00, hasTime false', () => {
    expect(best(RFP, 'qa_deadline')).toMatchObject({ value: '2026-02-20T17:00', hasTime: false });
  });

  it('optional site visit is not mandatory; date in the cell before the label counts', () => {
    const lines = page(1, 'April 1, 2026 9:00 AM | Optional site visit (not mandatory)');
    expect(best(lines, 'site_walk')).toMatchObject({ value: '2026-04-01T09:00', mandatory: false });
  });

  it('takes the date from the next line when the label line has none', () => {
    const lines = page(1, 'Bid Opening:', 'Thursday, April 16, 2026, 2:00 PM');
    expect(best(lines, 'due')?.value).toBe('2026-04-16T14:00');
  });

  it('a "questions due date" line is a Q&A deadline, not the due date', () => {
    const lines = page(1, 'Questions due date: February 20, 2026');
    expect(pick(lines, 'due')).toBeUndefined();
    expect(best(lines, 'qa_deadline')?.value).toBe('2026-02-20T17:00');
  });

  it('skips a table-of-contents line with no date', () => {
    expect(pick(page(1, 'Proposals due ........ 5'), 'due')).toBeUndefined();
  });
});

describe('extract — text fields', () => {
  it('bid number from a label and from the RFP pattern', () => {
    const list = pick(RFP, 'bid_number')!.map((c) => c.value);
    expect(list[0]).toBe('RFP 26-114');
    expect(best(page(1, 'Solicitation Number: 2026-0412'), 'bid_number')?.value).toBe('2026-0412');
    expect(best(page(1, 'IFB #2026-07 Network Cabling'), 'bid_number')?.value).toBe('IFB 2026-07');
  });

  it('agency name and type from page 1', () => {
    expect(best(RFP, 'agency_name')?.value).toBe('Harbor County School District');
    expect(best(RFP, 'agency_type')?.value).toBe('k12');
    expect(best(page(1, 'City of Lakeview', 'Invitation for Bid'), 'agency_type')?.value).toBe('city');
    expect(best(page(1, 'Lone Star College System'), 'agency_type')?.value).toBe('higher_ed');
  });

  it('title from the line after the solicitation header, or after a label', () => {
    expect(best(RFP, 'title')?.value).toBe('Student Chromebooks');
    expect(best(page(1, 'Project Title: Districtwide Wi-Fi Refresh'), 'title')?.value).toBe('Districtwide Wi-Fi Refresh');
  });

  it('sealed submission with copies, notarization and a delivery address', () => {
    expect(best(RFP, 'submission_method')?.value).toBe('sealed');
    expect(best(RFP, 'copies_required')?.value).toBe('5');
    expect(best(RFP, 'notarize_required')?.value).toBe('true');
    const lines = page(2, 'Deliver to: Purchasing Office, 200 Elm Ave, Room 12');
    expect(best(lines, 'delivery_address')?.value).toBe('Purchasing Office, 200 Elm Ave, Room 12');
  });

  it('online submission through a known portal', () => {
    const lines = page(1, 'Responses shall be submitted electronically via Bonfire at https://harbor.bonfirehub.com/opportunities/123.');
    expect(best(lines, 'submission_method')?.value).toBe('online');
    expect(best(lines, 'portal_name')?.value).toBe('Bonfire');
    expect(best(lines, 'portal_url')?.value).toBe('https://harbor.bonfirehub.com/opportunities/123');
  });

  it('timezone from "Central Time" or CST', () => {
    expect(best(RFP, 'timezone')?.value).toBe('America/Chicago');
    expect(best(page(1, 'due 2:00 PM EST'), 'timezone')?.value).toBe('America/New_York');
  });

  it('estimated value from a money label', () => {
    expect(best(page(1, 'Estimated budget: $480,000.00'), 'est_value')?.value).toBe('480000');
  });
});

describe('extract — contact', () => {
  it('buyer email, nearby name, title and phone', () => {
    expect(extract(RFP, [], TODAY).contact).toEqual({
      firstName: 'Jane', lastName: 'Doe', title: 'Purchasing Agent', email: 'jdoe@harbor.k12.tx.us',
      phone: '(555) 201-3344', text: 'jdoe@harbor.k12.tx.us | (555) 201-3344', page: 2,
    });
  });

  it('"Contact:" name on the same line', () => {
    const c = extract(page(1, 'Contact: John Smith, Buyer, jsmith@lakeview.gov, 555-410-2000'), [], TODAY).contact;
    expect(c).toMatchObject({ firstName: 'John', lastName: 'Smith', title: 'Buyer', email: 'jsmith@lakeview.gov', phone: '555-410-2000' });
  });

  it('prefers the email near "questions" / "purchasing" over a footer email', () => {
    const lines = [...page(1, 'webmaster@harbor.org'), ...page(3, 'Direct questions to Ann Lee, Senior Buyer, alee@harbor.org')];
    expect(extract(lines, [], TODAY).contact?.email).toBe('alee@harbor.org');
  });
});

describe('extract — learned labels', () => {
  const lines = page(1, 'Bid Opening: March 10, 2026 2:00 PM', 'Sobres cerrados entrega final: March 3, 2026 at 11:00 AM');

  it('a learned label outranks a built-in one and is marked learned', () => {
    const due = pick(lines, 'due', [{ field: 'due', phrase: 'sobres cerrados entrega final', hits: 2 }])!;
    expect(due[0]).toMatchObject({ value: '2026-03-03T11:00', learned: true, phrase: 'sobres cerrados entrega final' });
    expect(due[1]).toMatchObject({ value: '2026-03-10T14:00', learned: false });
  });

  it('ignores learned labels for fields that are not label fields', () => {
    expect(() => extract(lines, [{ field: 'agency_type', phrase: 'bid opening', hits: 1 }], TODAY)).not.toThrow();
  });
});

describe('extract — E-Rate', () => {
  const FORM470: Line[] = page(1,
    'FCC Form 470 | Description of Services Requested and Certification Form',
    'Form 470 Application Number: 270012345',
    'Funding Year: 2027',
    'Billed Entity Number: 123456',
    'Category 2 | Internal Connections',
    'Certified Date/Time: 01/05/2026 3:14 PM',
  );

  it('tags the bid E-Rate and reads 470 #, funding year and category', () => {
    expect(best(FORM470, 'erate')?.value).toBe('true');
    expect(best(FORM470, 'erate_470_number')?.value).toBe('270012345');
    expect(best(FORM470, 'erate_funding_year')?.value).toBe('2027');
    expect(best(FORM470, 'erate_category')?.value).toBe('2');
  });

  it('allowable contract date = certified + 28 days when no ACD is given, with a note', () => {
    expect(best(FORM470, 'allowable_contract')).toMatchObject({
      value: '2026-02-02T17:00', hasTime: false, note: 'calculated: posted Jan 5, 2026 + 28 days',
    });
  });

  it('an explicit Allowable Contract Date wins over the calculation', () => {
    const lines = [...FORM470, ...page(1, 'Allowable Contract Date: February 3, 2026')];
    expect(pick(lines, 'allowable_contract')!.map((c) => c.value)).toEqual(['2026-02-03T17:00']);
  });

  it('district RFP wording: FY range, Category One and Two, E-rate', () => {
    const lines = page(1, 'This E-rate eligible RFP covers FY 2027-2028.', 'Services: Category One and Category Two');
    expect(best(lines, 'erate')?.value).toBe('true');
    expect(best(lines, 'erate_funding_year')?.value).toBe('2027');
    expect(best(lines, 'erate_category')?.value).toBe('both');
    expect(best(page(1, 'USAC eligible', 'C1 data transmission'), 'erate_category')?.value).toBe('1');
  });

  it('no E-Rate words → no E-Rate fields, even with "application number"', () => {
    const s = extract(page(1, 'Application Number: 270012345', 'Funding year 2027'), [], TODAY);
    expect(s.fields.erate).toBeUndefined();
    expect(s.fields.erate_470_number).toBeUndefined();
    expect(s.fields.erate_funding_year).toBeUndefined();
  });
});

describe('helpers', () => {
  it('labelRegex: case, spacing, optional hyphen, whole words', () => {
    expect(labelRegex('pre-bid conference').test('PREBID   Conference')).toBe(true);
    expect(labelRegex('pre-bid conference').test('pre bid conference')).toBe(true);
    expect(labelRegex('bid no').test('bid not')).toBe(false);
    expect(labelRegex('rfp #').test('RFP # 12')).toBe(true);
  });

  it('isEmptySuggestions', () => {
    expect(isEmptySuggestions(extract(page(1, 'Nothing useful here.'), [], TODAY))).toBe(true);
    expect(isEmptySuggestions(extract(RFP, [], TODAY))).toBe(false);
  });
});

describe('review fixes', () => {
  it('agency type: federal cues first, state-name departments are state, USACE districts are federal', () => {
    const type = (name: string) => best(page(1, name), 'agency_type')?.value;
    expect(type('Air Force Academy')).toBe('federal');
    expect(type('Florida Department of Transportation')).toBe('state');
    expect(type('Kansas City District (USACE)')).toBe('federal');
    expect(type('Federal Way Public Schools')).toBe('k12');
    expect(type('Lakeview Academy')).toBe('k12');
  });

  it('category codes C1/C2 are case-sensitive', () => {
    expect(best(page(1, 'USAC eligible', 'c1 data transmission'), 'erate_category')).toBeUndefined();
    expect(best(page(1, 'USAC eligible', 'C2 internal connections'), 'erate_category')?.value).toBe('2');
  });

  it('generic "date posted" only counts with a Form 470 cue on the page', () => {
    const generic = page(1, 'This E-rate eligible RFP covers FY 2027.', 'Date posted: January 5, 2026');
    expect(best(generic, 'allowable_contract')).toBeUndefined();
    const cued = page(1, 'This E-rate eligible RFP covers FY 2027.', 'FCC Form 470 summary', 'Date posted: January 5, 2026');
    expect(best(cued, 'allowable_contract')?.value).toBe('2026-02-02T17:00');
    expect(best(page(1, 'E-rate RFP', 'Certified date: January 5, 2026'), 'allowable_contract')?.value).toBe('2026-02-02T17:00');
  });
});

describe('golden tuning — dates', () => {
  it('a weekday that does not fit the date lowers that candidate', () => {
    // "Friday, March 6" (no year): no year soon has March 6 on a Sunday → the guess is flagged and ranks below a clean date.
    const due = pick(page(1, 'Bids due Sunday, March 6 at 2:00 PM', 'Bid opening: March 10, 2026 2:00 PM'), 'due')!;
    expect(due.map((c) => c.value)).toEqual(['2026-03-10T14:00', '2026-03-06T14:00']);
  });
});

describe('golden tuning — due date wording and layouts', () => {
  const due = (...texts: string[]) => best(page(1, ...texts), 'due')?.value;

  it('date on the next line and its time on the line after', () => {
    expect(due('RFP # 12-2026', 'Deadline for Submittal of Proposals', 'March 3rd, 2026', '2:00 p.m. (CST)')).toBe('2026-03-03T14:00');
  });

  it('a time that wraps to the next line', () => {
    expect(due('All bid proposals are due no later than March 3, 2026,', 'at 2:00 p.m. PST. Late proposals are returned.')).toBe('2026-03-03T14:00');
  });

  it('portal printouts: "End Date", "Current End Date:", "BID closes at"', () => {
    expect(due('Start Date Feb 20, 2026 4:30:00 PM EST', 'End Date Mar 3, 2026 4:30:00 PM EST | [Respond to bid]')).toBe('2026-03-03T16:30');
    expect(due('Current Start Date: 02/20/2026 02:00 PM', 'Current End Date: 03/03/2026 01:30 PM Eastern Time')).toBe('2026-03-03T13:30');
    expect(due('RFQ ID | IT26001', 'BID closes at | 3/3/26 at 2:00PM')).toBe('2026-03-03T14:00');
  });

  it('a label in a table header takes the value in the same column of the next row', () => {
    expect(due('Delivery Required | Quote Not Later Than | Payment Terms | F. O. B.', 'ASAP | 03/03/2026 - 02:00 P.M. | NET 30 | DESTINATION'))
      .toBe('2026-03-03T14:00');
  });
});

describe('golden tuning — bid numbers', () => {
  const num = (...texts: string[]) => best(page(1, ...texts), 'bid_number')?.value;

  it('"Bid: QQ #123", "REF. NO.", "RE: RFQ-…", "Bid Solicitation: # …"', () => {
    expect(num('Response Details Report', 'Bid: QQ #104455 - Display Units | Start Date Feb 1, 2026')).toBe('104455');
    expect(num('DATE: | 02/01/2026 | REF. NO. RFQ-2026-10442 | PAGE: 1 | OF 1')).toBe('RFQ-2026-10442');
    expect(num('DATE: | 02/01/2026 | REF. NO. | RFQ-2026-311 | PAGE: 1')).toBe('RFQ-2026-311');
    expect(num('TO: | PROSPECTIVE PROPOSERS', 'RE: RFQ-2026-10442')).toBe('RFQ 2026-10442');
    expect(num('Request for Bid', 'Bid Solicitation: # 2026-001-004')).toBe('2026-001-004');
  });

  it('a file name in a list of attachments is not a bid number', () => {
    expect(num('ID | Name', '238000 | Harbor Cabling RFP 2027_03_Final')).toBeUndefined();
  });
});

describe('golden tuning — Q&A deadline wording', () => {
  const qa = (...texts: string[]) => best(page(1, ...texts), 'qa_deadline')?.value;

  it('"Requests for Information (RFI)" and "inquiries must be … received no later than"', () => {
    expect(qa('Deadline for Vendor Requests for Information (RFI) March 4, 2026, 2:00 PM PST')).toBe('2026-03-04T14:00');
    expect(qa('Inquiries must be in writing; written inquiries must be sent by email and arrive no later than Monday, March 2 ,2026 at 2:00 P.M.'))
      .toBe('2026-03-02T14:00');
  });

  it('a sentence that wraps before its date', () => {
    expect(qa('Vendors with concerns: inquiries must be in writing and reach the buyer no later',
      'than Monday, March 2, 2026 at 2:00 P.M.; the answers will follow within a week')).toBe('2026-03-02T14:00');
    // A finished sentence does not borrow a date from the next line.
    expect(qa('Questions must be received in writing.', 'March 2, 2026 board meeting')).toBeUndefined();
    // "N/A" answers the label; the next line's date belongs to the next line's own label.
    expect(best(page(1, 'Pre-Bid Location: N/A', 'Questions Due to City: March 2, 2026, 12:00 p.m.'), 'pre_bid')).toBeUndefined();
  });
});

describe('golden tuning — agency', () => {
  const agency = (...texts: string[]) => best(page(1, ...texts), 'agency_name')?.value;

  it('an agency name at the start of a long address line', () => {
    expect(agency('Bid documents', 'Harbor Falls School District #12 400 Main Street Harbor Falls, ID 83000')).toBe('Harbor Falls School District #12');
  });

  it('housing authorities', () => {
    expect(agency('Request for Bid', 'Housing Authority of the Lakeview Nation', 'PO Box 10')).toBe('Housing Authority of the Lakeview Nation');
  });

  it('"City of X" inside a sentence when no line names the agency', () => {
    expect(agency('BUREAU OF PURCHASING, ONE MAIN PLAZA, 3rd FLOOR, HARBOR, NY 10000', 'REQUEST FOR QUOTATION',
      'NOTE: The State Tax Law exempts the City of Harbor from the payment of sales and use taxes on all purchases made by the city.'))
      .toBe('City of Harbor');
    // A proper agency line still wins.
    expect(agency('Harbor County School District', 'Purchases by the City of Harbor are tax exempt under state law for all departments.'))
      .toBe('Harbor County School District');
  });
});

describe('golden tuning — E-Rate details and contacts', () => {
  const F470 = (...extra: string[]) => page(1,
    'FCC Form 470 – Funding Year 2027',
    'Form 470 Application Number: 270012345',
    'Billed Entity | Contact Information',
    'HARBOR SCHOOL | Jane Doe',
    '1 MAIN ST HARBOR, FL 33000 | consult@erate-help.com',
    'Category One Service Requests',
    'Service Type | Function | Function',
    'Category Two Service Requests',
    'Internal Connections | Switches and Necessary | No Preference | 10 | Each',
    ...extra,
  );

  it('Form 470 section headings do not count as a category; the requested service types do', () => {
    expect(best(F470(), 'erate_category')?.value).toBe('2');
    expect(best(F470('Data Transmission and/or | Internet Access and | 100 Mbps'), 'erate_category')?.value).toBe('both');
  });

  it('category words deep in an appendix do not change the category of the request', () => {
    const lines = [
      ...page(1, 'E-RATE FUNDING YEAR 2027', 'CABLING UPGRADE: INTERNAL CONNECTIONS'),
      ...page(30, 'Special construction for Category 1 services'),
    ];
    expect(best(lines, 'erate_category')?.value).toBe('2');
  });

  it('"470# 270012345"', () => {
    expect(best(page(1, 'E-RATE FUNDING YEAR 2027', 'RFP NO. 2027-03', '470# 270012345'), 'erate_470_number')?.value).toBe('270012345');
  });

  it('a combined pre-bid conference / job walk is one stop (pre-bid), not also a site walk', () => {
    const lines = page(1, 'Mandatory Pre-Bid Job Walk & Site Survey | March 2, 2026, 3:00 PM');
    expect(best(lines, 'pre_bid')).toMatchObject({ value: '2026-03-02T15:00', mandatory: true });
    expect(best(lines, 'site_walk')).toBeUndefined();
    expect(best(page(1, 'Site visit | March 4, 2026 10:00 AM', 'Pre-bid meeting | March 2, 2026 3:00 PM'), 'site_walk')?.value).toBe('2026-03-04T10:00');
  });

  it('a Form 470 that sends bids to the Technical Contact: that contact is the buyer', () => {
    const lines = F470('Narrative', 'Please submit all bids to the designated Technical Contact listed on the FCC Form 470.',
      'Technical Contact', 'Jane Doe', 'EMAIL ONLY', 'jdoe@erate-help.com');
    expect(extract(lines, [], TODAY).contact?.email).toBe('jdoe@erate-help.com');
    expect(extract(F470('Technical Contact', 'Sam Lee', 'slee@harbor.org'), [], TODAY).contact?.email).toBe('consult@erate-help.com');
  });
});

describe('golden tuning — titles', () => {
  const title = (...texts: string[]) => best(page(1, ...texts), 'title')?.value;

  it('the text after a bid number: "Bid QQ #104455 - Display Units", "Bid #26-131, Whiteboards"', () => {
    expect(title('Response Details Report Bid QQ #104455 - Interactive Display Units')).toBe('Interactive Display Units');
    expect(title('INVITATION FOR BIDS', 'Bid #26-131, Whiteboards and Display Cases')).toBe('Whiteboards and Display Cases');
  });

  it('"Contract name:" is a title label', () => {
    expect(title('CONTRACT INDEX NO: UE26-01', 'CONTRACT NAME: Uninterrupted Power Supply')).toBe('Uninterrupted Power Supply');
  });

  it('fill-in form cells, deadlines and addendum notices are not titles', () => {
    expect(title('Name of person quoting: | E-Mail:', 'Title: | NYS Contract #:')).toBeUndefined();
    expect(title('RFP # 12-2026', 'Deadline for Submittal of Proposals')).toBeUndefined();
    expect(title('RFQ-2026-10442: ADDENDUM No. 1 – ACKNOWLEDGEMENT – Return this document', 'Bidding Firm: ______________')).toBeUndefined();
  });
});

describe('review fixes — false positives', () => {
  const due = (...texts: string[]) => best(page(1, ...texts), 'due')?.value;
  const qa = (...texts: string[]) => best(page(1, ...texts), 'qa_deadline')?.value;
  const agency = (...texts: string[]) => best(page(1, ...texts), 'agency_name')?.value;
  const title = (...texts: string[]) => best(page(1, ...texts), 'title')?.value;

  it('a contract term "End Date" is not the due date', () => {
    expect(due('Contract Term | Start Date | End Date', 'Initial term | 07/01/2026 | 06/30/2029')).toBeUndefined();
    expect(due('Service period', 'End Date: 06/30/2029')).toBeUndefined();
    expect(due('Solicitation | Start Date | End Date', 'Network switches | 02/20/2026 | 03/03/2026')).toBe('2026-03-03T17:00');
  });

  it('"due no later than" after questions, inquiries, insurance or samples is not the due date', () => {
    expect(due('All questions are due no later than Feb 20, 2026 at 2:00 PM.')).toBeUndefined();
    expect(due('Certificates of insurance are due no later than Feb 20, 2026.')).toBeUndefined();
    expect(due('Sealed bids are due no later than March 3, 2026 at 2:00 PM.')).toBe('2026-03-03T14:00');
  });

  it('a wrapped sentence does not take a date that belongs to the next label, or a negated one', () => {
    expect(qa('All questions must be received in writing before the', 'February 20, 2026 site visit at the main office.')).toBeUndefined();
    expect(best(page(1, 'A pre-bid conference will not be held for this', 'March 2, 2026 opening as first planned'), 'pre_bid')).toBeUndefined();
  });

  it('agency at the start of a long line: no street number, no notices, requests or sentences', () => {
    expect(agency('Harbor Falls School District 400 Main Street Harbor Falls, ID 83000 Phone 555-555-0100 Fax 555-555-0101'))
      .toBe('Harbor Falls School District');
    expect(agency('Notice To Bidders Harbor Falls School District 400 Main Street Harbor Falls ID 83000 Phone 555-555-0100')).toBeUndefined();
    expect(agency('Request For Proposals For Harbor Falls School District Technology Department Network Refresh Project 2026 Phase One'))
      .toBeUndefined();
    expect(agency('THE BIDDER SHALL NOTIFY THE SCHOOL DISTRICT IN WRITING OF ANY ERRORS FOUND IN THESE DOCUMENTS BEFORE BIDS ARE OPENED'))
      .toBeUndefined();
  });

  it('a schedule table: the row\'s event names the date, not the "Due Date" column header', () => {
    const lines = page(1, 'Event | Due Date | Location', 'Pre-bid | February 1, 2026 | Room 5', 'Proposals due | March 3, 2026 2:00 PM | City Hall');
    expect(best(lines, 'due')?.value).toBe('2026-03-03T14:00');
    expect(pick(lines, 'due')!.map((c) => c.value)).not.toContain('2026-02-01T17:00');
    expect(best(lines, 'pre_bid')?.value).toBe('2026-02-01T17:00');
  });

  it('"reference number" mid-sentence does not beat an ITB number', () => {
    expect(best(page(1, 'ITB 2026-07', 'Your reference number 44812 must appear on invoices.'), 'bid_number')?.value).toBe('ITB 2026-07');
  });

  it('the Technical Contact boost needs bids sent to that contact, not a rejection', () => {
    const F = (...extra: string[]) => page(1, 'FCC Form 470 – Funding Year 2027', 'Billed Entity | Contact Information', 'HARBOR SCHOOL | Jane Doe',
      '1 MAIN ST HARBOR, FL 33000 | consult@erate-help.com', ...extra, 'Technical Contact', 'Sam Lee', 'slee@harbor.org');
    expect(extract(F('Bids sent to the Technical Contact will be rejected.'), [], TODAY).contact?.email).toBe('consult@erate-help.com');
    expect(extract(F('Do not submit bids to the Technical Contact.'), [], TODAY).contact?.email).toBe('consult@erate-help.com');
    expect(extract(F('Please send all proposals to the Technical Contact below.'), [], TODAY).contact?.email).toBe('slee@harbor.org');
  });

  it('a time on the next line only when that line is just the time', () => {
    expect(best(page(1, 'Bids due March 3, 2026', '2:00 PM Pre-bid conference in Room 5'), 'due')).toMatchObject({ value: '2026-03-03T17:00', hasTime: false });
  });

  it('"requests for information will be answered" is not a Q&A deadline', () => {
    expect(qa('Requests for information will be answered by March 4, 2026.')).toBeUndefined();
  });

  it('labels of different fields joined by "&" do not share a value', () => {
    expect(qa('Questions due & Bid opening | March 3, 2026 2:00 PM')).toBeUndefined();
  });

  it('text after a bid number mid-sentence is not a title', () => {
    expect(title('INVITATION FOR BIDS', 'Vendors responding to Bid #26-131, please sign every page')).not.toBe('please sign every page');
  });

  it('"County of Residence" and similar are not agencies', () => {
    expect(agency('Bidders must list their County of Residence and City of Business License on the form.')).toBeUndefined();
  });

  it('"does not include Category 1" does not count as Category 1', () => {
    expect(best(page(1, 'E-RATE FUNDING YEAR 2027', 'Category 2 internal connections', 'This RFP does not include Category 1 services.'), 'erate_category')?.value).toBe('2');
  });

  it('a weekday that does not fit a date with a year lowers that candidate', () => {
    const d = pick(page(1, 'Bids due Friday, March 3, 2026 at 2:00 PM', 'Bid opening: March 10, 2026 2:00 PM'), 'due')!;
    expect(d.map((c) => c.value)).toEqual(['2026-03-10T14:00', '2026-03-03T14:00']);
  });
});

describe('scope', () => {
  const DOC: Line[] = page(2,
    'Section 3 Scope of Work',
    'The town will replace core switches and add wireless access points at the library.',
    'Section 4 Insurance',
    'Carry the usual coverage.',
  );

  it('suggests a tag line plus the scope section summary, sourced at its first line', () => {
    const s = best(DOC, 'scope');
    expect(s?.value).toBe('Wi-Fi · Networking\nThe town will replace core switches and add wireless access points at the library.');
    expect(s).toMatchObject({ page: 2, text: 'The town will replace core switches and add wireless access points at the library.', learned: false });
    expect(pick(DOC, 'scope')).toHaveLength(1);
  });

  it('tags only when there is no scope section', () => {
    expect(best(page(1, 'Bid for toner cartridges', 'Toner must be OEM.'), 'scope')).toMatchObject({ value: 'Printing', text: 'Bid for toner cartridges', page: 1 });
  });

  it('nothing when neither tags nor a summary are found', () => {
    expect(pick(page(1, 'Hello there'), 'scope')).toBeUndefined();
  });

  it('uses team tag words and a learned scope heading (marked learned)', () => {
    const lines = page(1, 'What We Need', 'Thirty student desks for room 4.', 'Terms');
    const learned: LearnedLabel[] = [
      { field: 'scope_tag:Furniture', phrase: 'student desk', hits: 1 },
      { field: 'scope_heading', phrase: 'what we need', hits: 3 },
    ];
    expect(pick(lines, 'scope', learned)?.[0]).toMatchObject({
      value: 'Furniture\nThirty student desks for room 4.', learned: true, phrase: 'what we need',
    });
  });

  it('the source quote does not stop at an abbreviation', () => {
    const lines = page(1, 'Scope of Work', 'Furnish the U.S. Forest office with ten tablets. Deliver in May.', 'Terms');
    expect(best(lines, 'scope')?.text).toBe('Furnish the U.S. Forest office with ten tablets.');
  });

  it('a scope heading with almost no text under it gives no summary', () => {
    expect(best(page(1, 'Scope of work: see attached'), 'scope')).toBeUndefined();
  });
});
