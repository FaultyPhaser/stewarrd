import { plural } from '../../shared/format';
import { Anchored } from '../Anchored';
import { api } from '../store';
import type { Unit } from '../types';
import { Button } from './Button';

/** Seerr's season accordion headers read "Season 3" (or "Specials"); returns the header button for a season number. */
function findSeasonHeader(season: number): HTMLElement | null {
  const headers = document.querySelectorAll<HTMLElement>('button[id^="headlessui-disclosure-button"]');
  for (const header of Array.from(headers)) {
    const label = header.querySelector('span')?.textContent?.trim() ?? '';
    const m = /^Season\s+(\d+)$/i.exec(label);
    const number = m ? Number(m[1]) : (/^Specials$/i.test(label) ? 0 : null);
    if (number === season) return header;
  }
  return null;
}

/** Places the host just before the header's chevron, so it sits at the right edge next to the status badge. */
function attachToHeader(season: number, node: HTMLElement): boolean {
  const header = findSeasonHeader(season);
  if (!header) return false;
  const chevron = Array.from(header.children).filter((c) => c.tagName.toLowerCase() === 'svg').pop() ?? null;
  header.insertBefore(node, chevron);
  return true;
}

function SeasonButton({ unit, type, id }: { unit: Unit; type: string; id: string }) {
  const body = { type, id: Number(id), season: unit.seasonNumber };
  if (unit.isOwner && unit.status === 'ACTIVE') {
    if (unit.canFlag) {
      return <Button small onClick={() => api.post('/media/flag', body)}>Release</Button>;
    }
    return <Button small disabled onClick={() => {}}>{`${plural(unit.remainingDays ?? 0, 'day')} left`}</Button>;
  }
  if (!unit.isOwner && unit.status === 'FLAGGED_FOR_REMOVAL') {
    return <Button small disabled={!unit.canSave} onClick={() => api.post('/media/save', body)}>Save</Button>;
  }
  return null;
}

const hasAction = (u: Unit) => (u.isOwner && u.status === 'ACTIVE') || (!u.isOwner && u.status === 'FLAGGED_FOR_REMOVAL');

/** Release / Save buttons inside Seerr's per-season panels on a show page. */
export function SeasonActions({ units, type, id }: { units: Unit[]; type: string; id: string }) {
  return (
    <>
      {units.filter((u) => u.seasonNumber !== null && hasAction(u)).map((u) => (
        <Anchored key={u.unitId} id={`sidecar-season-${u.seasonNumber}`} tag="span" attach={(node) => attachToHeader(u.seasonNumber as number, node)}>
          {/* The header is itself a button that toggles the season, so clicks here must not reach it. */}
          <span class="sc-season-action" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <SeasonButton unit={u} type={type} id={id} />
          </span>
        </Anchored>
      ))}
    </>
  );
}
