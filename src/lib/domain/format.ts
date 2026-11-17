export function formatMoneyShort(n: number | null): string {
  if (n == null) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  // Round to the displayed unit first so 999_999 reads $1M, never $1000K.
  if (abs >= 1_000_000 || Math.round(abs / 1_000) >= 1_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${abs}`;
}
