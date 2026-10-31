import { useState } from 'preact/hooks';
import { userName } from '../../shared/format';
import { useApp } from '../context';
import type { AdminUser } from '../types';

export function Allowance({ users, defaultAllowance }: { users: AdminUser[]; defaultAllowance: number }) {
  const { api, say, refresh, guard } = useApp();
  const [userId, setUserId] = useState('');
  const [value, setValue] = useState('');

  const save = async (allowance: number | null) => {
    if (!Number(userId)) return say('Pick a user first.', true);
    const r = await api.post<{ before: number; after: number; balance: number }>('/admin/allowance', { userId: Number(userId), allowance });
    say(`Total credits ${r.before} → ${r.after}. Balance is now ${r.balance}.`);
    return refresh().then(() => undefined);
  };

  const set = () => {
    const raw = value.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) return say('Enter a whole number of 0 or more.', true);
    return save(n);
  };

  return (
    <>
      <h3>Credit allowance per user</h3>
      <p class="hint">Overrides the global total credits (<code>DEFAULT_CREDITS</code>) for one user. The user's balance changes immediately by the difference. Clear the override to return to the default.</p>
      <div class="admin-tools">
        <select aria-label="User" value={userId} onChange={(e) => setUserId(e.currentTarget.value)}>
          <option value="">— user —</option>
          {users.filter((u) => !u.isAdmin).map((u) => {
            const total = u.allowanceOverride === null ? `${defaultAllowance} (default)` : `${u.allowanceOverride} (override)`;
            return <option key={u.id} value={u.id}>{`${userName(u)} — total ${total}, balance ${u.credits}`}</option>;
          })}
        </select>
        <input type="number" min={0} step={1} placeholder="Total credits" aria-label="Total credits" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        <button type="button" onClick={guard(set)}>Set override</button>
        <button type="button" onClick={guard(() => save(null))}>Clear override</button>
      </div>
    </>
  );
}

export function ActAs({ users }: { users: AdminUser[] }) {
  const { flags, actAs, say, guard } = useApp();
  const [userId, setUserId] = useState('');
  return (
    <>
      <h3>Act as a user</h3>
      <p class="hint">
        Shows the dashboard as another user sees it, with their balance and media. Actions you take then are real actions for that user (including their Seerr requests). Admin tools stay yours. Expires after 8 hours or when you sign out.
        {flags.fakeLogin && ' Not used here: use the "Acting as" picker above.'}
      </p>
      <div class="admin-tools">
        <select aria-label="User to act as" value={userId} onChange={(e) => setUserId(e.currentTarget.value)}>
          <option value="">— user —</option>
          {users.filter((u) => !u.isAdmin).map((u) => <option key={u.id} value={u.id}>{`${userName(u)} — ${u.credits} credits`}</option>)}
        </select>
        <button type="button" onClick={guard(() => (Number(userId) ? actAs(Number(userId)) : say('Pick a user first.', true)))}>Act as user</button>
      </div>
    </>
  );
}
