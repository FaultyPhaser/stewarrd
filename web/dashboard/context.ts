import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Api } from '../shared/api';
import type { Me } from '../shared/types';
import type { Flags } from './types';

export type Tab = 'media' | 'maintenance' | 'admin' | 'settings';

export interface MessageLink {
  href: string;
  label: string;
}

export interface AppContext {
  flags: Flags;
  api: Api;
  me: Me | null;
  /** Bumped by every refresh(); lists reload when it changes. */
  version: number;
  say(text: string, isError?: boolean, link?: MessageLink): void;
  /** Re-reads the signed-in user and reloads every list. Rejects when signed out. */
  refresh(): Promise<Me>;
  setTab(tab: Tab): void;
  actAs(userId: number | null): Promise<void>;
  runImport(reset: boolean): Promise<void>;
  /** Wraps an action so a failure becomes the error message instead of an unhandled rejection. */
  guard(fn: () => Promise<unknown> | unknown): () => Promise<void>;
}

export const AppCtx = createContext<AppContext | null>(null);

export function useApp(): AppContext {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp must be used inside <App>');
  return ctx;
}
