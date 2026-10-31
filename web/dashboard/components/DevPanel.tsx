import { useEffect, useMemo, useState } from 'preact/hooks';
import { createApi } from '../../shared/api';
import { errorMessage } from '../../shared/format';
import type { Item } from '../../shared/types';
import { useApp } from '../context';
import { importInBatches } from '../importBatches';
import type { AdminUser, ImportResult } from '../types';
import { userLabel } from './adminShared';
import { DevSimulation } from './DevSimulation';

/** Simulation tools, only rendered when the server runs with fake login (DEV_MODE or ADMIN_RUN). */
export function DevPanel() {
  const { api, flags, say, refresh, guard } = useApp();
  const dev = useMemo(() => createApi(`${flags.apiBase}/dev`), [flags.apiBase]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  // The login cookie is HttpOnly, so remember the choice client-side for display.
  const [userId, setUserId] = useState(() => sessionStorage.getItem('devUser') || '');
  const [heldItems, setHeldItems] = useState<Item[]>([]);

  const loadUsers = async () => setUsers((await dev.get<{ users: AdminUser[] }>('/users')).users);
  const loadHeldItems = async () => {
    try {
      setHeldItems((await api.get<{ items: Item[] }>('/user/media')).items);
    } catch {
      setHeldItems([]); // not logged in yet
    }
  };
  const afterChange = async () => {
    await loadUsers();
    try {
      await refresh();
    } catch { /* still signed out */ }
    await loadHeldItems();
  };

  useEffect(() => {
    loadUsers().then(loadHeldItems).catch((err) => say(errorMessage(err), true));
  }, []);

  const seed = async () => {
    const { created } = await dev.post<{ created: number }>('/seed');
    say(`Seeded ${created} demo item(s). Pick a user.`);
    await afterChange();
  };

  const importReal = async () => {
    const ok = window.confirm(
      'This ERASES all local dev data (users, items, credits, ledger) and re-imports from Seerr.\n'
      + 'Nothing is changed in Seerr. Continue?',
    );
    if (!ok) return;
    say('Resetting and importing from Seerr (read-only)… this can take a while.');
    const total = await importInBatches(
      (body) => dev.post<ImportResult>('/import-real', body),
      true,
      (t) => say(`Imported ${t.imported} item(s) so far…`),
    );
    sessionStorage.removeItem('devUser');
    setUserId('');
    say(
      `Reset complete. Imported ${total.imported} item(s) and ${total.users} user(s) (${total.adminOwned} assigned to admin). `
      + `Charged ${total.charged} credit(s); ${total.overdrawn} user(s) below zero. Pick a user to continue.`,
    );
    await afterChange();
  };

  const login = async (id: string) => {
    setUserId(id);
    if (!id) return;
    await dev.post('/login', { userId: Number(id) });
    sessionStorage.setItem('devUser', id);
    say(`Now acting as user ${id}.`);
    await afterChange();
  };

  return (
    <section id="dev">
      {flags.adminRun
        ? <h2>Admin run <span class="hint">(ADMIN_RUN: real Seerr; release deletes and adopt creates the user's Seerr request)</span></h2>
        : <h2>Dev tools <span class="hint">(DEV_MODE, no Seerr needed)</span></h2>}
      <p>
        {flags.devMode && <button type="button" onClick={guard(seed)}>Seed demo data</button>}
        {' '}
        <button type="button" title="Erases local data, then copies users and ownership from Seerr (read-only on Seerr)" onClick={guard(importReal)}>Reset &amp; import real data</button>
        {' '}
        <label>
          Acting as{' '}
          <select value={userId} onChange={(e) => guard(() => login(e.currentTarget.value))()}>
            <option value="">— choose —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
          </select>
        </label>
      </p>
      {flags.devMode && <DevSimulation dev={dev} items={heldItems} afterChange={afterChange} />}
    </section>
  );
}
