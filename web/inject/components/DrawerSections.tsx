import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { formatCredits, plural } from '../../shared/format';
import { groupItems, matchesFilter } from '../../shared/groupItems';
import { summarize } from '../../shared/summarize';
import type { ActivityEvent, BulkResult, Item } from '../../shared/types';
import { groupFlagged, itemName } from '../groupFlagged';
import { seerrPath } from '../links';
import { api } from '../store';
import type { DrawerData } from '../types';
import { Button } from './Button';

const Heading = ({ children }: { children: ComponentChildren }) => <h4 class="sc-heading">{children}</h4>;
const Empty = ({ children }: { children: ComponentChildren }) => <div class="sc-empty">{children}</div>;

/** The title as a link to its Seerr page, or plain text when no TMDB id is known. */
function SeerrLink({ type, tmdbId, children }: { type: string; tmdbId?: number | null; children: ComponentChildren }) {
  const href = seerrPath(type, tmdbId);
  return href ? <a class="sc-link" href={href}>{children}</a> : <>{children}</>;
}
const ItemLink = ({ item, children }: { item: Item; children: ComponentChildren }) => (
  <SeerrLink type={item.type} tmdbId={item.tmdbId}>{children}</SeerrLink>
);

function Row({ label, action, className = '', onClick }: { label: ComponentChildren; action?: ComponentChildren; className?: string; onClick?: (e: MouseEvent) => void }) {
  return <div class={`sc-row ${className}${onClick ? ' sc-row--clickable' : ''}`} onClick={onClick}><span>{label}</span>{action}</div>;
}

export const AVAILABLE_ICON = '✅';
export const PENDING_ICON = '🕒';

/** Shows whether an owned item's files are downloaded yet. For a show, available means every active season is. */
function AvailIcon({ available, group = false }: { available: boolean; group?: boolean }) {
  const text = available
    ? (group ? 'All seasons are available' : 'Available')
    : (group ? 'Some seasons are not available yet' : 'Pending');
  return <span class="sc-avail" role="img" title={text} aria-label={text}>{available ? AVAILABLE_ICON : PENDING_ICON}</span>;
}

/** What the icons beside the Release buttons mean. */
export function Legend() {
  return (
    <div class="sc-legend" aria-label="Legend">
      <span class="sc-legend__item"><span aria-hidden="true">{AVAILABLE_ICON}</span>Available</span>
      <span class="sc-legend__item"><span aria-hidden="true">{PENDING_ICON}</span>Pending</span>
    </div>
  );
}

export function Balance({ data }: { data: DrawerData }) {
  const { me } = data;
  return (
    <>
      <div class="sc-balance">{`🪙 ${formatCredits(me.credits)} credits`}</div>
      {me.allowance !== null && <Empty>{`Your allowance is ${me.allowance}.`}</Empty>}
      <Empty>{`Requests cost ${plural(me.costs.movie, 'credit')} per movie and ${plural(me.costs.tv, 'credit')} per season.`}</Empty>
    </>
  );
}

function TypeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select class="sc-select" aria-label="Filter by type" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      <option value="">Movies &amp; TV</option>
      <option value="movie">Movies</option>
      <option value="tv">TV</option>
    </select>
  );
}

/** The type filter and search box on top of every list. */
function ListTools({ type, onType, query, onQuery, placeholder }: {
  type: string;
  onType: (v: string) => void;
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div class="sc-tools">
      <TypeSelect value={type} onChange={onType} />
      <input class="sc-search" type="search" placeholder={placeholder} aria-label={placeholder} maxLength={100}
        value={query} onInput={(e) => onQuery(e.currentTarget.value)} />
    </div>
  );
}

/** Which shows the user has opened. Kept in state so it survives list reloads. */
function useExpanded() {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (groupKey: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(groupKey)) next.add(groupKey);
    return next;
  });
  // The whole show row toggles, except clicks on its action button or links. The toggle button's own clicks bubble up here too.
  const rowToggle = (e: MouseEvent, groupKey: string) => {
    if ((e.target as HTMLElement).closest('.sc-btn, a')) return;
    toggle(groupKey);
  };
  return { open, rowToggle };
}

/** A show row's label: the expand toggle with the show title. */
function ShowLabel({ title, isOpen }: { title: string; isOpen: boolean }) {
  return (
    <button type="button" class="sc-toggle" aria-expanded={isOpen}>
      {`${isOpen ? '▾' : '▸'} ${title}`}
    </button>
  );
}

const seasonName = (i: Item): string => (i.seasonNumber === null ? i.label : `Season ${i.seasonNumber}`);
const allAvailable = (items: Item[]): boolean => items.every((i) => i.available !== false);

export function MyMedia({ owned, costs }: { owned: DrawerData['owned']; costs: DrawerData['me']['costs'] }) {
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const { open, rowToggle } = useExpanded();

  const release = (i: Item) => api.post('/media/flag', { unitId: i.unitId });
  const releaseAll = async (groupKey: string, title: string, active: number) => {
    if (!window.confirm(`Release ${active} season(s) of "${title}"? Seasons still inside the minimum stewardship time are skipped. Each released season refunds ${plural(costs.tv, 'credit')}.`)) return;
    const r = await api.post<{ results: BulkResult[] }>('/media/flag-show', { groupKey });
    window.alert(summarize(r.results, 'Released', title).text);
  };
  const action = (i: Item) => (i.status === 'ACTIVE'
    ? (
      <span class="sc-action">
        <AvailIcon available={i.available !== false} />
        {i.remainingDays ? <Button small disabled onClick={() => {}}>{`${i.remainingDays}d left`}</Button> : <Button small onClick={() => release(i)}>Release</Button>}
      </span>
    )
    : <span class="sc-count">Leaving soon</span>);

  const entries = groupItems(owned.items);
  const matches = (i: Item) => matchesFilter(i, type, query);
  const visible = entries.filter((e) => (e.kind === 'item' ? matches(e.item) : e.group.items.some(matches)));
  const count = !entries.length ? '' : visible.length ? `Showing ${visible.length} of ${entries.length}` : `No matches (${entries.length} total)`;

  return (
    <>
      <Heading>My media</Heading>
      {!owned.items.length && <Empty>Nothing yet.</Empty>}
      {owned.items.length > 0 && (
        <>
          <ListTools type={type} onType={setType} query={query} onQuery={setQuery} placeholder="Search my media" />
          {/* <div class="sc-count">{count}</div> */}
          <div class="sc-scroll">
            {visible.map((entry) => {
              if (entry.kind === 'item') return <Row key={`i${entry.item.unitId}`} label={<ItemLink item={entry.item}>{itemName(entry.item)}</ItemLink>} action={action(entry.item)} />;
              const { group } = entry;
              const isOpen = open.has(group.groupKey);
              const activeItems = group.items.filter((i) => i.status === 'ACTIVE');
              const active = activeItems.length;
              return (
                <div key={`g${group.groupKey}`}>
                  <Row className={`sc-row--group${isOpen ? ' is-open' : ''}`} onClick={(e) => rowToggle(e, group.groupKey)} action={
                    <span class="sc-action">
                      {active > 0 && <AvailIcon available={allAvailable(activeItems)} group />}
                      <Button small disabled={!active} onClick={() => releaseAll(group.groupKey, group.title, active)}>Release all</Button>
                    </span>
                  } label={<ShowLabel title={group.title} isOpen={isOpen} />} />
                  {isOpen && (
                    <div class="sc-nest">
                      {group.items.filter(matches).map((i) => (
                        <Row key={i.unitId} className="sc-row--child" label={<ItemLink item={i}>{seasonName(i)}</ItemLink>} action={action(i)} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* <Empty>Releasing becomes available once the minimum stewardship time has passed.</Empty> */}
        </>
      )}
    </>
  );
}

export function LeavingSoon({ flagged, credits, costs }: { flagged: Item[]; credits: number | null; costs: DrawerData['me']['costs'] }) {
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const { open, rowToggle } = useExpanded();
  const shown = flagged.filter((i) => matchesFilter(i, type, query));

  const saveOne = (i: Item) => (
    <span class="sc-action">
      <AvailIcon available={i.available !== false} />
      <Button small disabled={!(i as Item & { canSave?: boolean }).canSave} onClick={() => api.post('/media/save', { unitId: i.unitId })}>
        Claim
      </Button>
    </span>
  );

  const saveAll = async (groupKey: string, title: string, n: number) => {
    if (!window.confirm(`Claim all ${n} released seasons of "${title}" for ${plural(n * costs.tv, 'credit')}?`)) return;
    const r = await api.post<{ results: { ok: boolean; label: string; error?: string }[] }>('/media/save-show', { groupKey });
    const failed = r.results.filter((x) => !x.ok);
    window.alert(`Claimed ${r.results.length - failed.length} of ${r.results.length} seasons of "${title}".`
      + (failed.length ? ` Skipped: ${failed.map((x) => `${x.label} (${x.error})`).join('; ')}.` : ''));
  };

  return (
    <>
      <Heading>Unclaimed</Heading>
      {!flagged.length && <Empty>Nothing unclaimed right now.</Empty>}
      {flagged.length > 0 && (
        <>
          <ListTools type={type} onType={setType} query={query} onQuery={setQuery} placeholder="Search leaving soon" />
          {!shown.length && <Empty>No matches.</Empty>}
          {shown.length > 0 && (
            <div class="sc-scroll">
              {groupFlagged(shown).map((entry) => {
                if (entry.kind === 'single') return <Row key={entry.item.unitId} label={<ItemLink item={entry.item}>{itemName(entry.item)}</ItemLink>} action={saveOne(entry.item)} />;
                const n = entry.seasons.length;
                const canAffordAll = credits === null || credits >= n * costs.tv;
                const isOpen = open.has(entry.groupKey);
                return (
                  <div key={`show${entry.groupKey}`}>
                    <Row className={`sc-row--group${isOpen ? ' is-open' : ''}`} onClick={(e) => rowToggle(e, entry.groupKey)} action={
                      <span class="sc-action">
                        <AvailIcon available={allAvailable(entry.seasons)} group />
                        <Button small disabled={!canAffordAll} onClick={() => saveAll(entry.groupKey, entry.title, n)}>{`Claim All`}</Button>
                      </span>
                    } label={<ShowLabel title={entry.title} isOpen={isOpen} />} />
                    {isOpen && (
                      <div class="sc-nest">
                        {entry.seasons.map((s) => <Row key={s.unitId} className="sc-row--child" label={<ItemLink item={s}>{seasonName(s)}</ItemLink>} action={saveOne(s)} />)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

export function Recent({ events }: { events: ActivityEvent[] }) {
  const [type, setType] = useState('');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = events.filter((e) => (!type || e.type === type) && (!needle || (e.title ?? '').toLowerCase().includes(needle)));

  return (
    <>
      <Heading>Recent requests</Heading>
      {!events.length && <Empty>No requests recorded yet.</Empty>}
      {events.length > 0 && (
        <>
          <ListTools type={type} onType={setType} query={query} onQuery={setQuery} placeholder="Search recent requests" />
          {!shown.length && <Empty>No matches.</Empty>}
          {shown.length > 0 && (
            <div class="sc-scroll">
              {shown.map((e, idx) => {
                const when = new Date(e.at);
                const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString();
                const verdict = e.action === 'DECLINED'
                  ? `❌ declined (needed ${plural(e.cost, 'credit')}, had ${e.balance})`
                  : `✅ ${String(e.action).toLowerCase()} (${plural(e.cost, 'credit')})`;
                return (
                  <Row key={idx}
                    label={<><SeerrLink type={e.type} tmdbId={e.tmdbId}>{e.title || `${e.type} ${e.tmdbId}`}</SeerrLink>{date && <span class="sc-count">{` · ${date}`}</span>}</>}
                    action={<span class="sc-count">{verdict}</span>} />
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

export { Empty };
