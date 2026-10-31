import type { Item } from '../../shared/types';
import { ownerOf, type Group } from '../../shared/groupItems';
import { summarize } from '../../shared/summarize';
import { useApp } from '../context';
import { useLoad } from '../hooks';
import type { AdminUser, IntegrityEntry, IntegrityRun } from '../types';
import { ActionButton } from './ActionButton';
import { MediaTable } from './MediaTable';
import { MasterList } from './MasterList';
import { ActAs, Allowance } from './UserTools';
import { CreditSettings } from './CreditSettings';
import { Stewardship } from './Stewardship';
import type { Summarizable } from './adminShared';

function SeerrImport() {
  const { runImport, guard } = useApp();
  const reset = () => {
    const ok = window.confirm('LAST RESORT: this ERASES all local data (users, items, credits, ledger) and re-imports from Seerr.\nNothing is changed in Seerr, but every local change is lost. Continue?');
    if (!ok) return undefined;
    const typed = window.prompt('Type RESET to confirm the full data reset.');
    return typed === 'RESET' ? runImport(true) : undefined;
  };
  return (
    <div class="danger-zone" role="group" aria-labelledby="danger-zone-title">
      <h3 id="danger-zone-title">⚠ Danger zone: full data reset</h3>
      <p><strong>Last resort only.</strong> This erases all local users, items, credits and the ledger, then re-imports from Seerr. It cannot be undone. Try the integrity check (Maintenance tab) first: it fixes most problems without losing data.</p>
      <p class="hint">The first import runs automatically the first time the admin signs in to an empty database.</p>
      <div class="admin-tools">
        <button type="button" class="danger" title="Erases all local data (users, items, credits, ledger) and re-imports" onClick={guard(reset)}>Reset &amp; re-import</button>
      </div>
    </div>
  );
}

function Report() {
  const { api, say, refresh } = useApp();
  const data = useLoad<{ items: Item[] }>('/admin/report');

  const purge = async (item: Item) => {
    if (!window.confirm(`Delete "${item.label}" and its files via Radarr/Sonarr? This cannot be undone.`)) return;
    await api.post(`/admin/purge/${item.unitId}`, { confirm: true });
    say(`Purged "${item.label}".`);
    await refresh();
  };

  const purgeAll = async (group: Group) => {
    const n = group.items.length;
    if (!window.confirm(`Delete ${n} released season(s) of "${group.title}" and their files via Sonarr? If every season of the show is released, the whole series is removed. This cannot be undone.`)) return;
    const r = await api.post<{ results: Summarizable }>(`/admin/purge-show/${encodeURIComponent(group.groupKey)}`, { confirm: true });
    const { text, isError } = summarize(r.results, 'Purged', group.title);
    say(text, isError);
    await refresh();
  };

  return (
    <MediaTable
      listId="report"
      columns={['Title', 'Type', 'Owner', 'Flagged', '']}
      empty="No unclaimed items."
      searchPlaceholder="Search by title or owner"
      items={data?.items ?? null}
      itemCells={(item, title) => (
        <>
          <td>{title}</td>
          <td>{item.type}</td>
          <td>{ownerOf(item)}</td>
          <td>{item.flaggedAt}</td>
          <td><ActionButton label="Purge…" danger onClick={() => purge(item)} /></td>
        </>
      )}
      groupCells={(group, titleCell) => (
        <>
          {titleCell}
          <td>tv</td>
          <td>{[...new Set(group.items.map(ownerOf))].join(', ')}</td>
          <td>{group.items.map((i) => i.flaggedAt).filter(Boolean).sort()[0] ?? ''}</td>
          <td><ActionButton label="Purge all…" danger onClick={() => purgeAll(group)} /></td>
        </>
      )}
    />
  );
}

function IntegrityLog() {
  const data = useLoad<{ entries: IntegrityEntry[] }>('/admin/integrity/log?limit=30');
  return (
    <>
      <h3>Integrity log</h3>
      <p class="hint">Every correction and warning from the integrity check (weekly, or on demand).</p>
      <div class="scroll">
        <table>
          <thead><tr><th>When</th><th>What</th><th>User</th><th>Before</th><th>After</th><th>Detail</th></tr></thead>
          <tbody id="integrity-log">
            {data && !data.entries.length && <tr><td colSpan={6}>No integrity events yet.</td></tr>}
            {data?.entries.map((e, i) => (
              <tr key={i}>
                <td>{e.timestamp}</td>
                <td>{e.kind}</td>
                <td>{e.username || e.userId || ''}</td>
                <td>{String(e.before ?? '')}</td>
                <td>{String(e.after ?? '')}</td>
                <td>{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function MaintenancePanel() {
  const { api, flags, say, refresh, guard } = useApp();

  const runIntegrity = async (dryRun: boolean) => {
    const r = await api.post<IntegrityRun>('/admin/integrity/run', dryRun ? { dryRun: true } : {});
    if (r.skipped) return say(r.skipped);
    const c = r.reconcile;
    if (c.skipped) say(`Integrity check: Radarr/Sonarr/Seerr step skipped (${c.skipped}).`, true);
    const blocked = c.blocked?.length ? ` ${c.blocked.length} removal(s) blocked: ${c.blocked.map((b) => b.reason).join('; ')}.` : '';
    const filled = r.seerr.removed.length;
    say(`${dryRun ? 'Dry run, nothing changed. Would: ' : 'Integrity check done: '}${r.pricing?.fixes.length ?? 0} price correction(s), ${r.balances.fixes.length} balance(s) corrected, ${c.added ?? 0} item(s) added, `
      + `${c.removed ?? 0} removed, ${c.updated ?? 0} download state(s) updated, ${filled} filled Seerr request(s) deleted, `
      + `${r.orphans.orphanUnits + r.orphans.orphanLedger} orphan(s) found.${blocked}`, Boolean(c.blocked?.length),
      r.reportFile ? { href: `${flags.apiBase}/admin/integrity/report/${encodeURIComponent(r.reportFile)}`, label: 'Download full details' } : undefined);
    return dryRun ? undefined : refresh().then(() => undefined);
  };

  return (
    <section class="panel">
      <h2>Integrity check</h2>
      <div class="admin-tools">
        <button type="button" title="Shows what the integrity check would change, without changing anything" onClick={guard(() => runIntegrity(true))}>Integrity check (dry run)</button>
        <button type="button" title="Fixes balances, matches Radarr/Sonarr and open Seerr requests, deletes filled Seerr requests" onClick={guard(() => runIntegrity(false))}>Run integrity check</button>
      </div>
      <h3>Ready to purge (unclaimed items)</h3>
      <p class="hint">Purging asks Radarr/Sonarr to delete the item and its files. Nothing is deleted automatically.</p>
      <Report />
      <IntegrityLog />
    </section>
  );
}

export function AdminPanel() {
  const data = useLoad<{ users: AdminUser[]; defaultAllowance: number }>('/admin/users');
  return (
    <section class="panel">
      {data && <MasterList users={data.users} />}
      {data && (
        <>
          <Allowance users={data.users} defaultAllowance={data.defaultAllowance} />
          <ActAs users={data.users} />
        </>
      )}
      <SeerrImport />
    </section>
  );
}

export function SettingsPanel() {
  return (
    <section class="panel">
      <CreditSettings />
      <Stewardship />
    </section>
  );
}
