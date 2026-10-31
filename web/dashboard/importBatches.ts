import type { ImportResult } from './types';

const EMPTY: ImportResult = { imported: 0, charged: 0, adminOwned: 0, users: 0, overdrawn: 0 };

/**
 * Pulls from Seerr in batches until the server reports it is done. Only the first batch of a reset erases data;
 * later batches continue the same import. `run` performs one request.
 */
export async function importInBatches(
  run: (body: Record<string, unknown>) => Promise<ImportResult>,
  reset: boolean,
  onProgress: (total: ImportResult) => void,
): Promise<ImportResult> {
  const total: ImportResult = { ...EMPTY };
  let first = reset;
  for (let batch = 0; batch < 100; batch += 1) {
    const r = await run(first ? { reset: true, confirm: true } : {});
    first = false;
    total.imported += r.imported;
    total.charged += r.charged;
    total.adminOwned += r.adminOwned;
    total.users = r.users;
    total.overdrawn = r.overdrawn;
    onProgress({ ...total });
    if (!r.capped || r.imported === 0) break;
  }
  return total;
}
