import { describe, expect, it } from 'vitest';
import { groupItems, matchesFilter } from './groupItems';
import type { Item } from './types';

const item = (over: Partial<Item>): Item => ({
  unitId: 1, groupKey: '1', type: 'movie', title: 'T', label: 'T', seasonNumber: null, status: 'ACTIVE', ...over,
});

describe('groupItems', () => {
  it('keeps movies single and groups seasons of one show in season order', () => {
    const entries = groupItems([
      item({ unitId: 1, groupKey: '10', type: 'tv', title: 'Show', label: 'Show S2', seasonNumber: 2 }),
      item({ unitId: 2, groupKey: '5', type: 'movie', title: 'Film' }),
      item({ unitId: 3, groupKey: '10', type: 'tv', title: 'Show', label: 'Show S1', seasonNumber: 1 }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['group', 'item']);
    const group = entries[0].kind === 'group' ? entries[0].group : null;
    expect(group?.items.map((i) => i.seasonNumber)).toEqual([1, 2]);
  });

  it('puts specials (season 0) before season 1', () => {
    const [entry] = groupItems([
      item({ unitId: 1, groupKey: '3', type: 'tv', seasonNumber: 1 }),
      item({ unitId: 2, groupKey: '3', type: 'tv', seasonNumber: 0 }),
    ]);
    expect(entry.kind === 'group' && entry.group.items.map((i) => i.seasonNumber)).toEqual([0, 1]);
  });
});

describe('matchesFilter', () => {
  const movie = item({ label: 'Alien', ownerName: 'Ripley' });
  it('matches everything with no filter', () => expect(matchesFilter(movie, '', '')).toBe(true));
  it('filters by type', () => {
    expect(matchesFilter(movie, 'tv', '')).toBe(false);
    expect(matchesFilter(movie, 'movie', '')).toBe(true);
  });
  it('searches label and owner, ignoring case and padding', () => {
    expect(matchesFilter(movie, '', ' ALIE ')).toBe(true);
    expect(matchesFilter(movie, '', 'ripley')).toBe(true);
    expect(matchesFilter(movie, '', 'predator')).toBe(false);
  });
});
