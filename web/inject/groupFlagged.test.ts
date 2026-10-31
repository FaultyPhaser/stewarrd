import { describe, expect, it } from 'vitest';
import { groupFlagged, itemName } from './groupFlagged';
import type { Item } from '../shared/types';

const item = (over: Partial<Item>): Item => ({
  unitId: 1, groupKey: '1', type: 'movie', title: 'T', label: 'T', seasonNumber: null, status: 'FLAGGED_FOR_REMOVAL', ...over,
});

describe('groupFlagged', () => {
  it('groups shows with two or more released seasons and keeps the rest single', () => {
    const out = groupFlagged([
      item({ unitId: 1, groupKey: '9', type: 'tv', title: 'Show', seasonNumber: 1 }),
      item({ unitId: 2, groupKey: '5' }),
      item({ unitId: 3, groupKey: '9', type: 'tv', title: 'Show', seasonNumber: 2 }),
      item({ unitId: 4, groupKey: '7', type: 'tv', title: 'Solo', seasonNumber: 1 }),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['show', 'single', 'single']);
    expect(out[0].kind === 'show' && out[0].seasons.length).toBe(2);
  });
});

describe('itemName', () => {
  it('appends the label only when it adds information', () => {
    expect(itemName(item({ title: 'Show', label: 'Show S2' }))).toBe('Show (Show S2)');
    expect(itemName(item({ title: 'Film', label: 'Film' }))).toBe('Film');
  });
});
