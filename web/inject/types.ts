import type { ActivityEvent, Item, Me } from '../shared/types';

export interface RequestInfo {
  unitCost: number;
  balance: number | null;
  canAfford: boolean;
}

export interface Unit extends Item {
  isOwner: boolean;
  canFlag?: boolean;
  canSave?: boolean;
}

export interface MediaStatus {
  tracked: boolean;
  units: Unit[];
  request: RequestInfo | null;
}

export interface DrawerData {
  me: Me;
  owned: { items: Item[] };
  flagged: { items: Item[] };
  activity: { events: ActivityEvent[] };
}

export interface BlockInfo {
  type: 'movie' | 'tv';
  unitCost: number;
  balance: number | null;
}
