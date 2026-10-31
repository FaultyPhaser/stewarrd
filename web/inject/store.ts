import { useEffect, useState } from 'preact/hooks';
import { createApi } from '../shared/api';
import type { Me } from '../shared/types';
import type { BlockInfo } from './types';

export const api = createApi('/sidecar-api');

export interface State {
  /** The signed-in user, once the credits call has succeeded. Cached so click handlers can decide synchronously. */
  me: Me | null;
  drawerOpen: boolean;
  path: string;
  /** Bumped by the DOM observer: Seerr is a SPA that re-renders under us, so anchored UI re-checks its host. */
  tick: number;
  /** Bumped after any change, so data-backed components reload. */
  version: number;
  block: BlockInfo | null;
}

/** Per-tab, cleared when the tab closes. Seerr navigation is a full page load for our links, so this keeps the drawer open across it. */
const DRAWER_KEY = 'stewarrd.drawerOpen';

function readDrawerOpen(): boolean {
  try {
    return window.sessionStorage.getItem(DRAWER_KEY) === '1';
  } catch {
    return false; // storage blocked (privacy mode etc.)
  }
}

function saveDrawerOpen(open: boolean): void {
  try {
    if (open) window.sessionStorage.setItem(DRAWER_KEY, '1');
    else window.sessionStorage.removeItem(DRAWER_KEY);
  } catch { /* nothing to do: the drawer just won't be remembered */ }
}

let state: State = { me: null, drawerOpen: readDrawerOpen(), path: window.location.pathname, tick: 0, version: 0, block: null };
const listeners = new Set<() => void>();

export const getState = (): State => state;

export function setState(patch: Partial<State>): void {
  if (patch.drawerOpen !== undefined && patch.drawerOpen !== state.drawerOpen) saveDrawerOpen(patch.drawerOpen);
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}

/** Re-reads the balance; silently does nothing when the user is not signed in to Seerr yet. */
export async function refreshMe(): Promise<void> {
  try {
    setState({ me: await api.get<Me>('/user/credits') });
  } catch { /* not logged in yet */ }
}

/** After an action: reload the balance and every data-backed component. */
export async function refreshAll(): Promise<void> {
  await refreshMe();
  setState({ version: state.version + 1 });
}

export const setDrawer = (open: boolean): void => setState({ drawerOpen: open });
