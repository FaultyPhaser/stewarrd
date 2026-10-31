import { describe, expect, it } from 'vitest';
import { formatCredits, plural, userName } from './format';

describe('format', () => {
  it('shows unlimited credits as an infinity sign', () => {
    expect(formatCredits(null)).toBe('∞');
    expect(formatCredits(0)).toBe('0');
  });

  it('pluralises', () => {
    expect(plural(1, 'credit')).toBe('1 credit');
    expect(plural(0, 'credit')).toBe('0 credits');
    expect(plural(2, 'season')).toBe('2 seasons');
  });

  it('falls back to the user id when there is no username', () => {
    expect(userName({ id: 4, username: 'ann' })).toBe('ann');
    expect(userName({ id: 4, username: null })).toBe('user 4');
  });
});
