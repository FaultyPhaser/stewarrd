import type { SeerrOutcome, Item } from '../../shared/types';
import { ownerOf, type Group } from '../../shared/groupItems';
import { summarize } from '../../shared/summarize';
import { useApp } from '../context';
import { useLoad } from '../hooks';
import { ActionButton } from './ActionButton';
import { MediaTable } from './MediaTable';

const seerrSuffix = (r: { seerr?: SeerrOutcome }) => (r.seerr?.message ? ` ${r.seerr.message}` : '');
const owners = (group: Group) => [...new Set(group.items.map(ownerOf))].join(', ');

export function MyMedia() {
  const { api, say, refresh, me } = useApp();
  const data = useLoad<{ items: Item[] }>('/user/media');
  const tvCost = me?.costs.tv ?? 0;

  const release = async (item: Item) => {
    await api.post('/media/flag', { unitId: item.unitId });
    say(`Released "${item.label}".`);
    await refresh();
  };

  const releaseAll = async (group: Group) => {
    const active = group.items.filter((i) => i.status === 'ACTIVE');
    if (!window.confirm(`Release ${active.length} season(s) of "${group.title}"? Seasons still inside the minimum stewardship time are skipped. Each released season refunds its cost (${tvCost} credit(s)).`)) return;
    const r = await api.post<{ results: Parameters<typeof summarize>[0] }>('/media/flag-show', { groupKey: group.groupKey });
    const { text, isError } = summarize(r.results, 'Released', group.title);
    say(text, isError);
    await refresh();
  };

  return (
    <section>
      <h2>My media</h2>
      <p class="hint">Release media you're done with to get back what it cost. Items are locked until you have held them for the minimum stewardship time.</p>
      <MediaTable
        listId="my-media"
        columns={['Title', 'Type', 'Status', '']}
        empty="Nothing here yet."
        searchPlaceholder="Search my media by title"
        items={data?.items ?? null}
        itemCells={(item, title) => (
          <>
            <td>{title}</td>
            <td>{item.type}</td>
            <td>{item.status === 'FLAGGED_FOR_REMOVAL' ? 'Leaving soon' : 'Active'}</td>
            <td>{item.status === 'ACTIVE' && (item.remainingDays ? <span class="hint">{`${item.remainingDays} day(s) left`}</span> : <ActionButton label="Release / Mark done" onClick={() => release(item)} />)}</td>
          </>
        )}
        groupCells={(group, titleCell) => {
          const active = group.items.filter((i) => i.status === 'ACTIVE').length;
          const leaving = group.items.length - active;
          return (
            <>
              {titleCell}
              <td>tv</td>
              <td>{`${active} active${leaving ? `, ${leaving} leaving soon` : ''}`}</td>
              <td>{active > 0 && <ActionButton label="Release all" onClick={() => releaseAll(group)} />}</td>
            </>
          );
        }}
      />
    </section>
  );
}

export function Flagged() {
  const { api, say, refresh, me } = useApp();
  const data = useLoad<{ items: Item[] }>('/media/flagged');
  const costOf = (type: string) => (type === 'movie' ? me?.costs.movie : me?.costs.tv) ?? 0;

  const save = async (item: Item) => {
    const r = await api.post<{ seerr?: SeerrOutcome }>('/media/save', { unitId: item.unitId });
    say(`You adopted "${item.label}".${seerrSuffix(r)}`, r.seerr?.action === 'error');
    await refresh();
  };

  const saveAll = async (group: Group) => {
    const n = group.items.length;
    if (!window.confirm(`Claim all ${n} released season(s) of "${group.title}" for ${n * costOf('tv')} credit(s)? Nothing is claimed unless your balance covers all of them.`)) return;
    const r = await api.post<{ results: Parameters<typeof summarize>[0] }>('/media/save-show', { groupKey: group.groupKey });
    const { text, isError } = summarize(r.results, 'Claimed', group.title);
    say(text, isError);
    await refresh();
  };

  return (
    <section>
      <h2>Leaving soon (adopt)</h2>
      <p class="hint">Items others released. Adopting costs the same as requesting (per movie or season) and makes you the owner.</p>
      <MediaTable
        listId="flagged"
        columns={['Title', 'Type', 'Released by', '']}
        empty="Nothing is leaving soon."
        searchPlaceholder="Search by title or user"
        items={data?.items ?? null}
        itemCells={(item, title) => (
          <>
            <td>{title}</td>
            <td>{item.type}</td>
            <td>{ownerOf(item)}</td>
            <td><ActionButton label={`Save (-${costOf(item.type)} credit)`} onClick={() => save(item)} /></td>
          </>
        )}
        groupCells={(group, titleCell) => (
          <>
            {titleCell}
            <td>tv</td>
            <td>{owners(group)}</td>
            <td><ActionButton label={`Save all (-${group.items.length * costOf('tv')} credits)`} onClick={() => saveAll(group)} /></td>
          </>
        )}
      />
    </section>
  );
}
