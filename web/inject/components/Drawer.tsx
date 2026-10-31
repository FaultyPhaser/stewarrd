import { useEffect, useState } from 'preact/hooks';
import { formatCredits } from '../../shared/format';
import type { Me, UserStats } from '../../shared/types';
import { api, setDrawer, setState, useStore } from '../store';
import { ASSET_BASE } from '../assets';
import type { DrawerData } from '../types';
import { Balance, Empty, Legend, LeavingSoon, MyMedia, Recent } from './DrawerSections';

/** One figure in the bar: an icon above a count, optionally "of" the server total. The label is kept for the tooltip and screen readers. */
function Stat({ icon, label, value, of, title }: { icon: string; label: string; value: string; of?: number; title?: string }) {
  const text = title ?? (of === undefined ? label : `${label}: ${value} of ${of} on the server`);
  return (
    <span class="sc-stat" title={text} aria-label={text} role="img">
      <span class="sc-stat__icon" aria-hidden="true">{icon}</span>
      <span class="sc-stat__value">{value}</span>
      {of !== undefined && <span class="sc-stat__of">{`/ ${of}`}</span>}
    </span>
  );
}

export function Drawer() {
  const { me, drawerOpen, version } = useStore();
  const [data, setData] = useState<DrawerData | null>(null);
  const [failed, setFailed] = useState(false);
  const [stats, setStats] = useState<UserStats | null>(null);

  useEffect(() => {
    if (!me || !drawerOpen) return undefined;
    let live = true;
    Promise.all([
      api.get<Me>('/user/credits'),
      api.get<DrawerData['owned']>('/user/media'),
      api.get<DrawerData['flagged']>('/media/flagged'),
      api.get<DrawerData['activity']>('/user/activity?limit=10'),
    ]).then(([fresh, owned, flagged, activity]) => {
      if (!live) return;
      setState({ me: fresh });
      setData({ me: fresh, owned, flagged, activity });
      setFailed(false);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [Boolean(me), drawerOpen, version]);

  // Bar stats are light (a few counts), so reload them whenever the drawer toggles or something changed.
  useEffect(() => {
    if (!me) return undefined;
    let live = true;
    api.get<UserStats>('/user/stats').then((s) => { if (live) setStats(s); }).catch(() => { /* keep the last numbers */ });
    return () => { live = false; };
  }, [Boolean(me), drawerOpen, version]);

  // Reserve room on the right of the Seerr page for the bar, only while it is shown.
  const signedIn = Boolean(me);
  useEffect(() => {
    if (!signedIn) return undefined;
    document.documentElement.classList.add('sc-bar-active');
    return () => { document.documentElement.classList.remove('sc-bar-active'); };
  }, [signedIn]);

  if (!me) return null; // only for signed-in users, once the credits call has succeeded
  const balance = formatCredits(me.credits);
  return (
    <>
      <aside id="sidecar-drawer" class={`sc-drawer${drawerOpen ? ' is-open' : ''}`}>
        <div id="sidecar-drawer-body" class="sc-drawer__body">
          {failed && <Empty>Unable to load your Stewarrd info. Try again in a moment.</Empty>}
          {!failed && data && (
            <>
              <Legend />
              <Balance data={data} />
              <MyMedia owned={data.owned} costs={data.me.costs} />
              <LeavingSoon flagged={data.flagged.items} credits={data.me.credits} costs={data.me.costs} />
              <Recent events={data.activity.events} />
            </>
          )}
        </div>
      </aside>
      <button id="sidecar-drawer-tab" type="button" class="sc-tab" title={`Stewarrd: ${balance} credits`} aria-label={`Open Stewarrd. ${balance} credits`} onClick={() => setDrawer(!drawerOpen)}>
        <img src={`${ASSET_BASE}/images/tab.png`} alt="Stewarrd" draggable={false} />
        <span class="sc-tab__credits">{`🪙 ${balance}`}</span>
        {stats && (
          <span class="sc-tab__stats">
            <Stat icon="🎬" label="Your movies" value={String(stats.movies.mine)} of={stats.movies.total} />
            <Stat icon="📺" label="Your seasons" value={String(stats.seasons.mine)} of={stats.seasons.total} />
            <Stat icon="⏳" label="Unclaimed" value={String(stats.unclaimed.total)} title={`Unclaimed: ${stats.unclaimed.movies} movies, ${stats.unclaimed.seasons} seasons`} />
          </span>
        )}
      </button>
    </>
  );
}
