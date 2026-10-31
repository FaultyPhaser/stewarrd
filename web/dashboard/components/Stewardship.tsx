import { useEffect, useState } from 'preact/hooks';
import { useApp } from '../context';
import { useLoad } from '../hooks';

interface Settings {
  minStewardshipDays: number;
  applyToClaims: boolean;
  defaultMinStewardshipDays: number;
}

/** Admin setting: how long an owner must hold an item before releasing it (a rate limit on requests). */
export function Stewardship() {
  const { api, say, guard } = useApp();
  const data = useLoad<Settings>('/admin/settings');
  const [days, setDays] = useState('');
  const [claims, setClaims] = useState(true);

  useEffect(() => {
    if (!data) return;
    setDays(String(data.minStewardshipDays));
    setClaims(data.applyToClaims);
  }, [data]);

  const save = async () => {
    const n = Number(days.trim());
    if (days.trim() === '' || !Number.isInteger(n) || n < 0) return say('Enter a whole number of days, 0 or more.', true);
    const r = await api.post<Settings>('/admin/settings', { minStewardshipDays: n, applyToClaims: claims });
    return say(r.minStewardshipDays === 0
      ? 'Minimum stewardship disabled: owners can release at any time.'
      : `Minimum stewardship is now ${r.minStewardshipDays} day(s)${r.applyToClaims ? '' : ' (not applied to claimed items)'}.`);
  };

  if (!data) return null;
  return (
    <>
      <h3>Minimum stewardship time</h3>
      <p class="hint">
        How long an owner must hold an item before releasing it, to rate limit requests (default {data.defaultMinStewardshipDays} days, set with <code>MIN_STEWARDSHIP_DAYS</code>). 0 turns it off.
        The admin is never held to it, and an item deleted from the system is always refunded. Changes apply to everyone straight away.
      </p>
      <div class="admin-tools">
        <input type="number" min={0} max={3650} step={1} aria-label="Minimum stewardship days" value={days} onInput={(e) => setDays(e.currentTarget.value)} />
        {' '}days{' '}
        <label title="When off, only items a user requested are held; items they claim from Leaving soon can be released straight away">
          <input type="checkbox" checked={claims} onChange={(e) => setClaims(e.currentTarget.checked)} /> Apply to claimed (saved) items
        </label>
        <button type="button" onClick={guard(save)}>Save</button>
      </div>
    </>
  );
}
