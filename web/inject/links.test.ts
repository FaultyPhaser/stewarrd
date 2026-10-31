import { describe, expect, it } from 'vitest';
import { seerrPath } from './links';

describe('seerrPath', () => {
  it('builds movie and show paths', () => {
    expect(seerrPath('movie', 603)).toBe('/movie/603');
    expect(seerrPath('tv', 1396)).toBe('/tv/1396');
  });
  it('returns null without a usable id or type', () => {
    expect(seerrPath('movie', null)).toBeNull();
    expect(seerrPath('movie', undefined)).toBeNull();
    expect(seerrPath('tv', 0)).toBeNull();
    expect(seerrPath('anime', 5)).toBeNull();
  });
});
