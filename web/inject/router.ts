import { getState, refreshMe, setState } from './store';

export const ROUTE_RE = /^\/(movie|tv)\/(\d+)/;

export function currentRoute(path: string): { type: 'movie' | 'tv'; id: string } | null {
  const m = ROUTE_RE.exec(path);
  return m ? { type: m[1] as 'movie' | 'tv', id: m[2] } : null;
}

/** Seerr is a single-page app: follow its navigation and DOM changes. Call once. */
export function startRouter(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { me, tick } = getState();
      setState({ path: window.location.pathname, tick: tick + 1 });
      if (!me) void refreshMe();
    }, 300);
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  window.addEventListener('popstate', schedule);
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });

  // Another tab or a release may have changed the balance; re-read it when the tab is shown again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshMe();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && getState().drawerOpen) setState({ drawerOpen: false });
  });
  schedule();
}
