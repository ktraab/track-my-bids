import { describe, it, expect } from 'vitest';
import { isStableAppLocation } from './loginItem';

describe('isStableAppLocation', () => {
  it('accepts installed locations', () => {
    expect(isStableAppLocation('/Applications/TrackMyBids.app/Contents/Resources')).toBe(true);
    expect(isStableAppLocation('/Users/sam/Applications/TrackMyBids.app/Contents/Resources')).toBe(true);
    expect(isStableAppLocation('C:\\Users\\sam\\AppData\\Local\\TrackMyBids')).toBe(true);
  });
  it('rejects translocated copies and mounted disk images', () => {
    expect(isStableAppLocation('/private/var/folders/66/x/T/AppTranslocation/8ADD5B78/d/TrackMyBids.app/Contents/Resources')).toBe(false);
    expect(isStableAppLocation('/Volumes/TrackMyBids/TrackMyBids.app/Contents/Resources')).toBe(false);
  });
});
