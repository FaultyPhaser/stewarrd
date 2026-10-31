import { formatCredits, userName } from '../../shared/format';
import type { summarize } from '../../shared/summarize';
import type { AdminUser } from '../types';

export type Summarizable = Parameters<typeof summarize>[0];

export const userLabel = (u: AdminUser): string => `${userName(u)}${u.isAdmin ? ' (admin)' : ''} — ${formatCredits(u.credits)} credits`;
