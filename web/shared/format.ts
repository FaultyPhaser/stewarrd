/** `null` credits means unlimited (the admin). */
export const formatCredits = (credits: number | null): string => (credits === null ? '∞' : String(credits));

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const userName = (u: { id: number; username?: string | null }): string => u.username || `user ${u.id}`;
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
