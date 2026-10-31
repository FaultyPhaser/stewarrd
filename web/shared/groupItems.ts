import type { Item } from './types';

export interface Group {
  groupKey: string;
  title: string;
  items: Item[];
}

export type Entry = { kind: 'item'; item: Item } | { kind: 'group'; group: Group };

/** Movies stay single rows; seasons of one show are grouped under a single show row (seasons in order). */
export function groupItems(items: Item[]): Entry[] {
  const entries: Entry[] = [];
  const shows = new Map<string, Group>();
  for (const item of items) {
    if (item.type !== 'tv') {
      entries.push({ kind: 'item', item });
      continue;
    }
    let group = shows.get(item.groupKey);
    if (!group) {
      group = { groupKey: item.groupKey, title: item.title, items: [] };
      shows.set(item.groupKey, group);
      entries.push({ kind: 'group', group });
    }
    group.items.push(item);
  }
  for (const entry of entries) {
    if (entry.kind === 'group') entry.group.items.sort((x, y) => (x.seasonNumber ?? 0) - (y.seasonNumber ?? 0));
  }
  return entries;
}

export const searchText = (item: Item): string => `${item.label ?? ''} ${item.ownerName ?? ''}`.toLowerCase();

/** Type filter plus free-text search, as used by every media list. `type` and `query` come from the list tools. */
export function matchesFilter(item: Item, type: string, query: string): boolean {
  return (!type || item.type === type) && (!query || searchText(item).includes(query.trim().toLowerCase()));
}

export const ownerOf = (item: Item): string | number | undefined => item.ownerName || item.ownerId;
