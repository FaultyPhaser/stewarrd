import type { Item } from '../shared/types';

export type FlaggedEntry =
  | { kind: 'single'; item: Item }
  | { kind: 'show'; groupKey: string; title: string; seasons: Item[] };

/** Released seasons of one show with two or more seasons collapse under a "Save all" row; everything else stays single. */
export function groupFlagged(items: Item[]): FlaggedEntry[] {
  const shows = new Map<string, Item[]>();
  for (const i of items) {
    if (i.type === 'tv') shows.set(i.groupKey, [...(shows.get(i.groupKey) ?? []), i]);
  }
  const done = new Set<string>();
  const out: FlaggedEntry[] = [];
  for (const i of items) {
    const seasons = i.type === 'tv' ? shows.get(i.groupKey) : undefined;
    if (!seasons || seasons.length < 2) {
      out.push({ kind: 'single', item: i });
    } else if (!done.has(i.groupKey)) {
      done.add(i.groupKey);
      out.push({ kind: 'show', groupKey: i.groupKey, title: i.title, seasons });
    }
  }
  return out;
}

export const itemName = (i: Item): string => (i.label && i.label !== i.title ? `${i.title} (${i.label})` : i.title);
