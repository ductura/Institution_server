// The eight user-visible sync states of Ductus src/domain/sync/states.ts
// (220b5db), the only part ported so far (DAN-851-2a2): a problem report names
// the state the editor was in. The reducer stays in Ductus until it is ported
// into this file. There is no ninth state and no implicit "saved".
export const SYNC_STATES = Object.freeze([
  "EDITING",
  "SAVING_LOCAL",
  "LOCAL_DURABLE",
  "SYNCING",
  "SYNCED",
  "CONFLICT",
  "ERROR",
  "RECOVERY_REQUIRED",
] as const);

export type SyncState = (typeof SYNC_STATES)[number];
