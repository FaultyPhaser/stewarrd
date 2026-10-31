export interface Flags {
  apiBase: string;
  assetBase: string;
  devMode: boolean;
  adminRun: boolean;
  fakeLogin: boolean;
}

export interface AdminUser {
  id: number;
  username?: string | null;
  isAdmin: boolean;
  credits: number | null;
  allowanceOverride: number | null;
}

export interface IntegrityEntry {
  timestamp: string;
  kind: string;
  username?: string | null;
  userId?: number | null;
  before: unknown;
  after: unknown;
  detail: string;
}

export interface ImportResult {
  imported: number;
  charged: number;
  adminOwned: number;
  users: number;
  overdrawn: number;
  capped?: boolean;
}

export interface IntegrityRun {
  skipped?: string;
  /** Dry runs only: name of the detail file, downloadable from /admin/integrity/report/:name. */
  reportFile?: string;
  pricing?: { fixes: unknown[] };
  balances: { fixes: unknown[] };
  reconcile: { skipped?: string; added?: number; removed?: number; updated?: number; blocked?: { reason: string }[] };
  seerr: { removed: number[] };
  orphans: { orphanUnits: number; orphanLedger: number };
}
