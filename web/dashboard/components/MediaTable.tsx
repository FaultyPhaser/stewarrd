import { Fragment, type ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { plural } from '../../shared/format';
import type { Item } from '../../shared/types';
import { groupItems, matchesFilter, type Group } from '../../shared/groupItems';

interface Props {
  /** Unique per table; also keys which shows are open. */
  listId: string;
  columns: string[];
  empty: string;
  searchPlaceholder: string;
  /** `null` while loading. */
  items: Item[] | null;
  /** Cells of a movie row or a season row. `title` is the movie label or "Season N". */
  itemCells: (item: Item, title: string) => ComponentChildren;
  /** Cells of a show row. `titleCell` already holds the expand/collapse toggle. */
  groupCells: (group: Group, titleCell: ComponentChildren) => ComponentChildren;
  /** Extra controls rendered with the filters (e.g. a user filter). */
  extraFilters?: ComponentChildren;
  /** Extra predicate combined with the type and search filters. */
  extraFilter?: (item: Item) => boolean;
  /** When set, a checkbox column is added on the left. `onToggle` receives the unit ids and the new state. */
  selection?: { selected: ReadonlySet<number>; onToggle: (unitIds: number[], on: boolean) => void };
}

/** A filterable list in which seasons of one show collapse under a single show row. */
export function MediaTable({ listId, columns, empty, searchPlaceholder, items, itemCells, groupCells, extraFilters, extraFilter, selection }: Props) {
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  // Shows the user has opened. Kept here, so it survives list reloads.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (groupKey: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(groupKey)) next.add(groupKey);
    return next;
  });

  const entries = groupItems(items ?? []);
  const matches = (item: Item) => matchesFilter(item, type, query) && (!extraFilter || extraFilter(item));
  const visible = entries.filter((e) => (e.kind === 'item' ? matches(e.item) : e.group.items.some(matches)));
  const visibleIds = visible.flatMap((e) => (e.kind === 'item' ? [e.item.unitId] : e.group.items.filter(matches).map((i) => i.unitId)));
  const allSelected = (ids: number[]) => ids.length > 0 && ids.every((id) => selection?.selected.has(id));
  const checkCell = (ids: number[], label: string) => selection && (
    <td class="check">
      <input type="checkbox" aria-label={label} checked={allSelected(ids)} onChange={(e) => selection.onToggle(ids, e.currentTarget.checked)} />
    </td>
  );
  const colSpan = columns.length + (selection ? 1 : 0);
  const count = !entries.length ? '' : visible.length ? `Showing ${visible.length} of ${entries.length}` : `No matches (${entries.length} total)`;

  return (
    <>
      <div class="list-tools" data-list={listId}>
        <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.currentTarget.value)}>
          <option value="">Movies &amp; TV</option>
          <option value="movie">Movies</option>
          <option value="tv">TV</option>
        </select>
        <input
          type="search"
          placeholder={searchPlaceholder}
          aria-label="Search"
          maxLength={100}
          value={query}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        {extraFilters}
        <span class="count hint">{count}</span>
      </div>
      <div class="scroll">
        <table>
          <thead>
            <tr>
              {selection && (
                <th class="check">
                  <input type="checkbox" aria-label="Select all shown" checked={allSelected(visibleIds)} onChange={(e) => selection.onToggle(visibleIds, e.currentTarget.checked)} />
                </th>
              )}
              {columns.map((c) => <th key={c}>{c}</th>)}
            </tr>
          </thead>
          <tbody id={listId}>
            {items !== null && !items.length && <tr><td colSpan={colSpan}>{empty}</td></tr>}
            {visible.map((entry) => {
              if (entry.kind === 'item') {
                return <tr key={`i${entry.item.unitId}`}>{checkCell([entry.item.unitId], `Select ${entry.item.label}`)}{itemCells(entry.item, entry.item.label)}</tr>;
              }
              const { group } = entry;
              const isOpen = open.has(group.groupKey);
              const titleCell = (
                <td>
                  <button type="button" class="toggle" aria-expanded={isOpen} onClick={() => toggle(group.groupKey)}>
                    {isOpen ? '▾' : '▸'} {group.title} ({plural(group.items.length, 'season')})
                  </button>
                </td>
              );
              return (
                <Fragment key={`g${group.groupKey}`}>
                  <tr class="group">{checkCell(group.items.filter(matches).map((i) => i.unitId), `Select all seasons of ${group.title}`)}{groupCells(group, titleCell)}</tr>
                  {isOpen && group.items.filter(matches).map((item) => (
                    <tr key={`s${item.unitId}`} class="season">
                      {checkCell([item.unitId], `Select ${item.label}`)}
                      {itemCells(item, item.seasonNumber === null ? item.label : `Season ${item.seasonNumber}`)}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
