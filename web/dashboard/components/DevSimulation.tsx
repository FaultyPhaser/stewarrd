import { useState } from 'preact/hooks';
import type { Api } from '../../shared/api';
import type { Item } from '../../shared/types';
import { useApp } from '../context';

interface Props {
  dev: Api;
  items: Item[];
  afterChange: () => Promise<void>;
}

/** DEV_MODE only: simulate a Seerr request and backdate how long the current user has held an item. */
export function DevSimulation({ dev, items, afterChange }: Props) {
  const { say, guard } = useApp();
  const [heldItem, setHeldItem] = useState('');
  const [days, setDays] = useState('30');
  const [title, setTitle] = useState('');
  const [type, setType] = useState('movie');
  const [seasons, setSeasons] = useState('1');
  const [available, setAvailable] = useState(true);

  const simulateRequest = async () => {
    const r = await dev.post<{ action: string; cost: number; balance: number }>('/request', {
      title, type, seasons: Number(seasons) || 1, available,
    });
    say(
      r.action === 'approved'
        ? `Approved for ${r.cost} credit(s). Balance: ${r.balance}.`
        : `Declined: costs ${r.cost}, balance is ${r.balance}.`,
      r.action !== 'approved',
    );
    setTitle('');
    await afterChange();
  };

  const backdate = async () => {
    const unitId = Number(heldItem);
    if (!unitId) throw new Error('Pick one of your items first');
    await dev.post('/backdate', { unitId, daysAgo: Number(days) || 0 });
    say('Hold time updated. Try releasing the item.');
    await afterChange();
  };

  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); guard(simulateRequest)(); }}>
        <input placeholder="Title to request" required maxLength={120} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        {' '}
        <select value={type} onChange={(e) => setType(e.currentTarget.value)}>
          <option value="movie">Movie</option>
          <option value="tv">TV</option>
        </select>
        {' '}
        <input type="number" min={1} max={20} title="Seasons (TV)" value={seasons} onInput={(e) => setSeasons(e.currentTarget.value)} />
        {' '}
        <label title="Untick to simulate a request that has not downloaded yet">
          <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.currentTarget.checked)} /> already downloaded
        </label>
        {' '}
        <button type="submit">Simulate request</button>
      </form>
      <p class="hint">
        Pretend you took one of your items{' '}
        <select value={heldItem} onChange={(e) => setHeldItem(e.currentTarget.value)}>
          <option value="">— item —</option>
          {items.map((i) => <option key={i.unitId} value={i.unitId}>{i.label}</option>)}
        </select>
        {' '}
        <input type="number" min={0} title="Days ago" value={days} onInput={(e) => setDays(e.currentTarget.value)} />
        {' '}days ago <button type="button" onClick={guard(backdate)}>Set</button>
      </p>
    </>
  );
}
