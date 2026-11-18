/**
 * Whether the app may (re)write its login item from this location. macOS runs apps opened
 * straight from Downloads or a disk image from a throwaway copy ("App Translocation") or from
 * the mounted image itself; a login item pointing there breaks once that copy is gone.
 */
export function isStableAppLocation(resourceDir: string): boolean {
  const p = resourceDir.replace(/\\/g, '/');
  return !p.includes('/AppTranslocation/') && !p.startsWith('/Volumes/');
}
