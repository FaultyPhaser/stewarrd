import type { Api } from '../shared/api';
import type { Me } from '../shared/types';

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** After Plex sends the browser back, the PIN cookie is still set: wait for the sign-in to complete. */
export async function finishPlexLogin(api: Api, attempts = 30, delayMs = 2000): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const r = await api.post<{ status: string }>('/auth/plex/poll');
    if (r.status === 'ok') return true;
    if (r.status !== 'pending') return false;
    await sleep(delayMs);
  }
  return false;
}

/** Whether a freshly signed-in user should trigger the automatic first import (admin, empty database). */
export async function needsInitialImport(api: Api, who: Me, fakeLogin: boolean): Promise<boolean> {
  if (!who.isAdmin || fakeLogin) return false;
  const { needsImport } = await api.get<{ needsImport: boolean }>('/admin/setup-status');
  return needsImport;
}
