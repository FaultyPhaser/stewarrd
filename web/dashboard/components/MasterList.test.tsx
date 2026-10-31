// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { AppCtx, type AppContext } from '../context';
import { MasterList } from './MasterList';

describe('MasterList', () => {
  it('renders rows from /admin/media', async () => {
    const api = {
      get: async () => ({
        items: [
          { unitId: 1, groupKey: '1', type: 'movie', title: 'Alien', label: 'Alien', seasonNumber: null, status: 'ACTIVE', ownerId: 2, ownerName: 'bob' },
        ],
      }),
      post: async () => ({}),
    };
    const ctx = { api, say: () => {}, refresh: async () => ({}), guard: (f: () => unknown) => async () => { await f(); }, version: 0 } as unknown as AppContext;
    render(<AppCtx.Provider value={ctx}><MasterList users={[]} /></AppCtx.Provider>);
    await waitFor(() => expect(screen.getByText('Alien')).toBeTruthy());
    expect(screen.getByText('bob')).toBeTruthy();
  });
});
