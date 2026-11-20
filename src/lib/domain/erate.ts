/** E-Rate (USAC / FCC Form 470) details carried by a bid. */
export interface ErateInfo {
  erate: boolean;
  erate470Number: string | null;
  erateFundingYear: number | null;
  /** 1, 2, or null = both / unknown. */
  erateCategory: 1 | 2 | null;
}

/** "Form 470 #270012345 · FY2027 · Cat 2" — missing parts are left out ("E-Rate bid" if none); '' when not an E-Rate bid. */
export function erateSummary(b: ErateInfo): string {
  if (!b.erate) return '';
  const parts = [
    b.erate470Number ? `Form 470 #${b.erate470Number}` : '',
    b.erateFundingYear ? `FY${b.erateFundingYear}` : '',
    b.erateCategory ? `Cat ${b.erateCategory}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'E-Rate bid';
}

/** Funding year typed in a form: 2000–2100, else null. */
export function parseFundingYear(s: string): number | null {
  const n = Number(s.trim());
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null;
}

/** Category select value ('' | '1' | '2') → stored value. */
export const toErateCategory = (s: string): 1 | 2 | null => (s === '1' ? 1 : s === '2' ? 2 : null);
