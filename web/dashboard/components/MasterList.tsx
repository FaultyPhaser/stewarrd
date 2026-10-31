import { useState } from 'preact/hooks';
import type { Item } from '../../shared/types';
import { ownerOf } from '../../shared/groupItems';
import { useApp } from '../context';
import { useLoad } from '../hooks';
import type { AdminUser } from '../types';
import { MediaTable } from './MediaTable';
import { userLabel } from './adminShared';

interface BulkResponse {
  assigned: number;
  totalCost: number;
  newBalance: number | null;
  skipped: { unitId: number; label: string; error: string }[];
}

export function MasterList({ users }: { users: AdminUser[] }) {
  const { api, say, refresh, guard } = useApp();
  const data = useLoad<{ items: Item[] }>('/admin/media');
  const [owner, setOwner] = useState('');
  const [target, setTarget] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const onToggle = (ids: number[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });

  const assign = async () => {
    const user = users.find((u) => String(u.id) === target);
    if (!user) return say('Pick a user to assign to first.', true);
    if (!selected.size) return say('Select at least one item first.', true);
    if (!window.confirm(`Assign ${selected.size} item(s) to ${userLabel(user)}?\nCredits are charged to the new owner and refunded to previous owners. The new owner's balance may go negative.`)) return;
    const r = await api.post<BulkResponse>('/admin/assign-bulk', { unitIds: [...selected], userId: user.id });
    const skipped = r.skipped.length
      ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.label} (${s.error})`).join('; ')}.`
      : '';
    say(`Assigned ${r.assigned} item(s), cost ${r.totalCost} credit(s).${skipped}`, r.assigned === 0 && r.skipped.length > 0);
    setSelected(new Set());
    await refresh();
  };

  const ownerFilter = (item: Item) => !owner || (owner === 'none' ? item.ownerId == null : String(item.ownerId) === owner);

  return (
    <>
      <h2>Admin: all media</h2>
      <p class="hint">Every active movie and season. Tick items, choose a user and assign. The new owner pays the normal cost and previous owners are refunded (the admin is never charged). Balances may go negative.</p>
      <MediaTable
        listId="master"
        columns={['Title', 'Type', 'Owner']}
        empty="No media."
        searchPlaceholder="Search by title or owner"
        items={data?.items ?? null}
        extraFilter={ownerFilter}
        extraFilters={(
          <select aria-label="Filter by user" value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
            <option value="">All users</option>
            <option value="none">No owner</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username || u.id}</option>)}
          </select>
        )}
        selection={{ selected, onToggle }}
        itemCells={(item, title) => (
          <>
            <td>{title}</td>
            <td>{item.type}</td>
            <td>{ownerOf(item)}</td>
          </>
        )}
        groupCells={(group, titleCell) => (
          <>
            {titleCell}
            <td>tv</td>
            <td>{[...new Set(group.items.map(ownerOf))].join(', ')}</td>
          </>
        )}
      />
      <div class="admin-tools bulk-bar">
        <select aria-label="Bulk assign to" value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="">Bulk assign — choose user —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
        </select>
        <button type="button" disabled={!selected.size || !target} onClick={guard(assign)}>{`Assign selected (${selected.size})`}</button>
      </div>
    </>
  );
}
