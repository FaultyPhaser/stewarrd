import { useEffect, useState } from 'preact/hooks';
import { formatCredits, plural } from '../../shared/format';
import type { ActivityEvent } from '../../shared/types';
import { Anchored } from '../Anchored';
import { currentRoute } from '../router';
import { api, useStore } from '../store';
import type { MediaStatus, RequestInfo, Unit } from '../types';
import { Button, Note } from './Button';
import { SeasonActions } from './SeasonActions';

const unitWord = (type: string) => (type === 'movie' ? 'movie' : 'season');

const findHost = (): Element | null => document.querySelector('[data-testid="media-header"]')
  || document.querySelector('.media-header')
  || document.querySelector('h1')?.parentElement
  || document.querySelector('main');

function CostNote({ type, request }: { type: string; request: RequestInfo | null }) {
  if (!request || request.unitCost === 0) return null;
  const cost = `Requesting costs ${plural(request.unitCost, 'credit')} per ${unitWord(type)}.`;
  return request.canAfford
    ? <Note>{`🪙 ${cost} You have ${formatCredits(request.balance)}.`}</Note>
    : <Note warn>{`🪙 ${cost} You have ${formatCredits(request.balance)}, so you can't request this right now.`}</Note>;
}

/** Warns when the user's most recent request for this title was declined. */
function DeclineNote({ type, id, version }: { type: string; id: string; version: number }) {
  const [last, setLast] = useState<ActivityEvent | null>(null);
  useEffect(() => {
    api.get<{ events: ActivityEvent[] }>('/user/activity?limit=50')
      .then(({ events }) => setLast(events.find((e) => e.type === type && e.tmdbId === Number(id)) ?? null))
      .catch(() => setLast(null));
  }, [type, id, version]);
  if (!last || last.action !== 'DECLINED') return null;
  return <Note warn>{`Your last request for this was declined: it needed ${plural(last.cost, 'credit')} and you had ${last.balance}.`}</Note>;
}

function UnitButton({ unit, type, id }: { unit: Unit; type: string; id: string }) {
  const body = { type, id: Number(id), season: unit.seasonNumber };
  const name = unit.seasonNumber === null ? '' : (unit.seasonNumber === 0 ? 'Specials: ' : `Season ${unit.seasonNumber}: `);
  if (unit.isOwner && unit.status === 'ACTIVE') {
    if (unit.canFlag) return <Button onClick={() => api.post('/media/flag', body)}>{`🚩 ${name}Done Watching (+1 Credit)`}</Button>;
    return <Button disabled onClick={() => {}}>{`🔒 ${name}In Use (${plural(unit.remainingDays ?? 0, 'day')} left)`}</Button>;
  }
  if (!unit.isOwner && unit.status === 'FLAGGED_FOR_REMOVAL') {
    return <Button disabled={!unit.canSave} onClick={() => api.post('/media/save', body)}>{`🛡️ ${name}Save Item (Transfer Ownership)`}</Button>;
  }
  return null;
}

/** Cost, decline notice and Done watching / Save buttons on a movie or show page. */
export function MediaPanel() {
  const { path, me, version } = useStore();
  const route = currentRoute(path);
  const [status, setStatus] = useState<MediaStatus | null>(null);
  const key = route ? `${route.type}:${route.id}` : '';

  useEffect(() => {
    setStatus(null);
    if (!route || !me) return undefined;
    let live = true;
    api.get<MediaStatus>(`/media/status?type=${route.type}&id=${route.id}`)
      .then((s) => { if (live) setStatus(s); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [key, version, Boolean(me)]);

  if (!route || !status) return null;
  const isTv = route.type === 'tv';
  // Movies keep their button in the panel; show seasons get theirs inside Seerr's season panels.
  const buttons = status.tracked && !isTv ? status.units.map((u) => <UnitButton key={u.unitId} unit={u} type={route.type} id={route.id} />) : [];
  const showCost = !status.tracked || isTv;
  return (
    <>
      <Anchored id="sidecar-media-panel" attach={(node) => {
        const host = findHost();
        if (!host) return false;
        host.appendChild(node);
        return true;
      }}>
        <div class="sc-panel">
          <DeclineNote type={route.type} id={route.id} version={version} />
          {showCost && <CostNote type={route.type} request={status.request} />}
          {buttons}
        </div>
      </Anchored>
      {status.tracked && isTv && <SeasonActions units={status.units} type={route.type} id={route.id} />}
    </>
  );
}
