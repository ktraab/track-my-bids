export const LINE_COLORS = [
  '#1f5fd1', '#b0540a', '#0b766c', '#7b4fd6',
  '#b8306d', '#2f7d32', '#a15c00', '#00739e',
];

export function pickLineColor(used: string[]): string {
  const usedLower = used.map((c) => c.toLowerCase());
  const free = LINE_COLORS.find((c) => !usedLower.includes(c.toLowerCase()));
  return free ?? LINE_COLORS[used.length % LINE_COLORS.length];
}

export function lineLetter(name: string): string {
  const m = name.trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : '?';
}
