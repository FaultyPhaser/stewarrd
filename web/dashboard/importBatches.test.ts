import { describe, expect, it } from 'vitest';
import { importInBatches } from './importBatches';
import type { ImportResult } from './types';

const batch = (over: Partial<ImportResult>): ImportResult => ({
  imported: 0, charged: 0, adminOwned: 0, users: 0, overdrawn: 0, ...over,
});

describe('importInBatches', () => {
  it('only resets on the first batch and sums the batches until the server is done', async () => {
    const bodies: unknown[] = [];
    const replies = [
      batch({ imported: 5, charged: 2, users: 3, capped: true }),
      batch({ imported: 4, charged: 1, users: 4, overdrawn: 1, capped: true }),
      batch({ imported: 1, users: 4, overdrawn: 1 }),
    ];
    const progress: number[] = [];
    const total = await importInBatches(async (body) => { bodies.push(body); return replies.shift()!; }, true, (t) => progress.push(t.imported));
    expect(bodies).toEqual([{ reset: true, confirm: true }, {}, {}]);
    expect(total).toEqual({ imported: 10, charged: 3, adminOwned: 0, users: 4, overdrawn: 1 });
    expect(progress).toEqual([5, 9, 10]);
  });

  it('stops when a capped batch imports nothing', async () => {
    let calls = 0;
    await importInBatches(async () => { calls += 1; return batch({ capped: true }); }, false, () => {});
    expect(calls).toBe(1);
  });
});
