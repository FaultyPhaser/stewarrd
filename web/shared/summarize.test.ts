import { describe, expect, it } from 'vitest';
import { summarize } from './summarize';

describe('summarize', () => {
  it('reports a clean bulk action', () => {
    expect(summarize([{ ok: true, label: 'S1' }], 'Released', 'Show'))
      .toEqual({ text: 'Released 1 of 1 season(s) of "Show".', isError: false });
  });

  it('lists skipped seasons and flags an error', () => {
    const r = summarize([{ ok: true, label: 'S1' }, { ok: false, label: 'S2', error: 'cooldown' }], 'Released', 'Show');
    expect(r.text).toContain('Released 1 of 2');
    expect(r.text).toContain('Skipped: S2 (cooldown).');
    expect(r.isError).toBe(true);
  });

  it('mentions Seerr failures', () => {
    const r = summarize([{ ok: true, label: 'S1', seerr: { action: 'error' } }], 'Released', 'Show');
    expect(r.text).toContain('Seerr request updates failed');
    expect(r.isError).toBe(true);
  });
});
