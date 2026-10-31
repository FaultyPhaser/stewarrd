import { useEffect, useState } from 'preact/hooks';
import { useApp } from '../context';
import { useLoad } from '../hooks';

interface CreditValues {
  defaultCredits: number;
  costMovie: number;
  costTvSeason: number;
}

interface Settings extends CreditValues {
  envDefaults: CreditValues;
}

interface SaveResult extends Settings {
  integrity: { skipped?: string; balances?: { fixes: unknown[] } } | null;
  repriced: number;
}

const isWhole = (s: string) => s.trim() !== '' && Number.isInteger(Number(s.trim())) && Number(s.trim()) >= 0;

/** Admin settings: total credits per user and what a movie / a season costs. Saving a change runs an integrity check. */
export function CreditSettings() {
  const { api, say, guard } = useApp();
  const data = useLoad<Settings>('/admin/settings');
  const [credits, setCredits] = useState('');
  const [movie, setMovie] = useState('');
  const [season, setSeason] = useState('');

  useEffect(() => {
    if (!data) return;
    setCredits(String(data.defaultCredits));
    setMovie(String(data.costMovie));
    setSeason(String(data.costTvSeason));
  }, [data]);

  const save = async () => {
    if (!data) return undefined;
    if (![credits, movie, season].every(isWhole)) return say('Enter whole numbers, 0 or more.', true);
    const next: CreditValues = { defaultCredits: Number(credits), costMovie: Number(movie), costTvSeason: Number(season) };
    const changed = (Object.keys(next) as (keyof CreditValues)[]).some((k) => next[k] !== data[k]);
    if (!changed) return say('No changes to save.');
    if (!window.confirm(
      'Changing these values triggers an integrity check straight away.\n\n'
      + 'Every user balance is recalculated from the ledger and the default credits, and any mismatch is overwritten '
      + '(see the integrity log).\n\n'
      + 'Ownership is zero-sum: whoever owns an item has paid exactly the current movie / season cost, and releasing '
      + 'refunds it. Requests, claims and releases are re-priced, so balances go up or down by the difference.\n\n'
      + 'Save and run the integrity check?',
    )) return undefined;
    const r = await api.post<SaveResult>('/admin/settings', next);
    const fixes = r.integrity?.balances?.fixes.length ?? 0;
    if (r.integrity?.skipped) return say(`Saved, but the integrity check did not run: ${r.integrity.skipped}. Run it from Maintenance.`, true);
    return say(`Credit settings saved. ${r.repriced} owned item(s) re-priced; integrity check corrected ${fixes} balance(s).`);
  };

  if (!data) return null;
  const hint = (k: keyof CreditValues) => `default ${data.envDefaults[k]}`;
  return (
    <>
      <h3>Credits</h3>
      <p class="hint">
        Total credits per user, and what a request costs. Environment values
        (<code>DEFAULT_CREDITS</code>, <code>CREDIT_COST_MOVIE</code>, <code>CREDIT_COST_TV_SEASON</code>) are the defaults.
        <strong> Saving a change runs an integrity check that recalculates every user's balance.</strong>
      </p>
      <div class="admin-tools">
        <label>Default credits ({hint('defaultCredits')}){' '}
          <input type="number" min={0} step={1} value={credits} onInput={(e) => setCredits(e.currentTarget.value)} />
        </label>
        <label>Movie cost ({hint('costMovie')}){' '}
          <input type="number" min={0} step={1} value={movie} onInput={(e) => setMovie(e.currentTarget.value)} />
        </label>
        <label>TV season cost ({hint('costTvSeason')}){' '}
          <input type="number" min={0} step={1} value={season} onInput={(e) => setSeason(e.currentTarget.value)} />
        </label>
        <button type="button" onClick={guard(save)}>Save</button>
      </div>
    </>
  );
}
