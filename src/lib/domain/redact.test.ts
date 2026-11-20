import { describe, it, expect } from 'vitest';
import { priceTableLines, redactLines, stripBidResponses } from './redact';

const p1 = (...t: string[]) => t.map((text) => ({ text, page: 1 }));

describe('redactLines', () => {
  it('replaces personal emails (keeping the domain), phones and nearby names; keeps role mailboxes and agencies', () => {
    const out = redactLines(p1(
      'Harbor County School District',
      'Questions to Jane Doe, Purchasing Agent',
      'jdoe@harbor.k12.us | (555) 201-3344 | bids@harbor.k12.us',
      'JANE DOE will open bids. Call (555) 201-3344.',
    ));
    expect(out.map((l) => l.text)).toEqual([
      'Harbor County School District',
      'Questions to Pat Morgan, Purchasing Agent',
      'person1@harbor.k12.us | 555-555-0100 | bids@harbor.k12.us',
      'Pat Morgan will open bids. Call 555-555-0100.',
    ]);
  });

  it('catches phones written without a space after the area code', () => {
    expect(redactLines(p1('Tel (555)201-3344 or 555.201.9999'))[0].text).toBe('Tel 555-555-0100 or 555-555-0101');
  });

  it('keeps place and agency names that look like "First Last"', () => {
    const out = redactLines(p1(
      'Cedar Falls School District #12, 40 Maple Grove Pkwy, Cedar Falls, ID 83000',
      'Submit to: Attention Ann Lee, Cedar Falls School District, jlee@cf.k12.us',
      'The Allowable Contract date is set by USAC. The allowable contract date applies.',
      'Contact: Allowable Contract Date',
    ));
    expect(out.map((l) => l.text)).toEqual([
      'Cedar Falls School District #12, 40 Maple Grove Pkwy, Cedar Falls, ID 83000',
      'Submit to: Attention Pat Morgan, Cedar Falls School District, person1@cf.k12.us',
      'The Allowable Contract date is set by USAC. The allowable contract date applies.',
      'Contact: Allowable Contract Date',
    ]);
  });

  it('finds ALL-CAPS names right before an email and names with a bare middle initial', () => {
    const out = redactLines(p1(
      'Welcome JANE DOE (jdoe@x.org) | Help',
      'RETURN QUOTATION VIA PORTAL ANN B. LEE Email: alee@x.org',
      'Consultants: Rob K Stone | rstone@y.com',
    ));
    expect(out.map((l) => l.text)).toEqual([
      'Welcome Pat Morgan (person1@x.org) | Help',
      'RETURN QUOTATION VIA PORTAL Sam Rivera Email: person2@x.org',
      'Consultants: Alex Chen | person3@y.com',
    ]);
  });

  it('applies extra replacements everywhere, case-insensitively', () => {
    const out = redactLines(p1('Submitted by ACME SUPPLY LLC for review'), { replace: { 'Acme Supply LLC': 'Our Company' } });
    expect(out[0].text).toBe('Submitted by Our Company for review');
  });

  it('is deterministic and keeps pages', () => {
    const input = [{ text: 'Contact: Ann Lee, alee@x.org', page: 2 }];
    expect(redactLines(input)).toEqual(redactLines(input));
    expect(redactLines(input)[0]).toEqual({ text: 'Contact: Pat Morgan, person1@x.org', page: 2 });
  });
});

describe('redactLines — phones and URLs', () => {
  const r = (...t: string[]) => redactLines(p1(...t)).map((l) => l.text);

  it('catches more phone layouts and drops extensions', () => {
    expect(r('Call (555)-201-3344 ext.51812', 'or 555/201-3344 X131', 'or 555 - 201 - 3344 x 154', 'Main +1 555 201 3344', 'Toll 1-555-201-9999'))
      .toEqual(['Call 555-555-0100', 'or 555-555-0100', 'or 555-555-0100', 'Main 555-555-0100', 'Toll 555-555-0101']);
  });

  it('bare 10-digit and 7-digit numbers only after a phone label', () => {
    expect(r('Phone: 5552013344', 'Fax 201-3344', 'Tel. #: 15552019999')).toEqual(['Phone: 555-555-0100', 'Fax 555-555-0101', 'Tel. #: 555-555-0102']);
    expect(r('FCC Registration Number 0012345678', 'Form 470 # 270012345', 'Invoice 201-3344')).toEqual(['FCC Registration Number 0012345678', 'Form 470 # 270012345', 'Invoice 201-3344']);
  });

  it('drops the query string of URLs that carry a session, checksum, token or vendor id', () => {
    expect(r(
      'https://portal.example.gov/ords/f?p=500:12:998877665544:::12:P12_ID:42&cs=3AbCdEf 1/2',
      'https://bids.example.com/vendor/report?bidId=1000&vendorId=2000 | 1/2',
      'https://bids.example.com/bidView?bidId=1000',
      'https://bids.example.com/riverside/bidView?bidId=1000',
    )).toEqual([
      'https://portal.example.gov/ords/f 1/2',
      'https://bids.example.com/vendor/report | 1/2',
      'https://bids.example.com/bidView?bidId=1000',
      'https://bids.example.com/riverside/bidView?bidId=1000',
    ]);
  });

  it('replacements match names that end in punctuation and domains inside emails', () => {
    expect(redactLines(p1('ACME SUPPLY DIST., INC. | Welcome (jdoe@acmesupply.com)'), { replace: { 'Acme Supply Dist., Inc.': 'Our Company', 'acmesupply.com': 'vendor.example' } })[0].text)
      .toBe('Our Company | Welcome (person1@vendor.example)');
  });
});

describe('stripBidResponses / priceTableLines', () => {
  const lines = [
    { text: 'Response Details Report Bid QQ #4455 - Display Units', page: 1 },
    { text: 'End Date Mar 3, 2026 4:30:00 PM EST', page: 1 },
    { text: 'ACME SUPPLY DIST., INC.', page: 1 },
    { text: 'Vendor Response', page: 1 },
    { text: 'Brand Contoso | Unit Price Qty. | Total', page: 1 },
    { text: 'Reference # | $1,200.00 2 $2,400.00', page: 1 },
    { text: 'Report header', page: 2 },
    { text: 'Line Item | Quantity | Unit Price | Amount', page: 2 },
    { text: 'Cable | 6 EA | $10.50 | $63.00', page: 2 },
  ];

  it('drops the vendor response, filled price tables and the company line above them; keeps the solicitation header', () => {
    const out = stripBidResponses(lines);
    expect(out.map((l) => l.text)).toEqual(['Response Details Report Bid QQ #4455 - Display Units', 'End Date Mar 3, 2026 4:30:00 PM EST', 'Report header']);
    expect(priceTableLines(out)).toEqual([]);
    expect(priceTableLines(lines).map((l) => l.text)).toEqual(['Vendor Response', 'Brand Contoso | Unit Price Qty. | Total', 'Reference # | $1,200.00 2 $2,400.00', 'Line Item | Quantity | Unit Price | Amount', 'Cable | 6 EA | $10.50 | $63.00']);
  });

  it('keeps blank bid forms and prose about prices', () => {
    const doc = p1('Your bid shall include unit price and extended price.', 'Qty | Unit Price | Extended', '1 | UPS frame | $ | $', 'Prices like $2500.00 or $1.50 are acceptable.');
    expect(stripBidResponses(doc)).toEqual(doc);
    expect(priceTableLines(doc)).toEqual([]);
  });
});
