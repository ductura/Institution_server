/**
 * Port types the session area receives from `server/database` (ARCHITECTURE
 * §2a): the shapes of Ductus src/server/db/with-actor.ts and
 * src/server/db/backchannel-logout.ts at d52a92c3, without `pg`. Temporary:
 * once S-0.17 (DAN-730) brings server/database, these become `import type`
 * from server/database/index.ts and this file goes.
 */
export type ActorTransaction = {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>;
};

export type WithActor = <T>(
  token: string | null | undefined,
  fn: (tx: ActorTransaction) => Promise<T>,
) => Promise<T>;

/** What a verified logout token names (DAN-474). `issuer` is the account key's spelling. */
export type BackchannelLogoutInput = {
  issuer: string;
  subject: string | null;
  sid: string | null;
  jti: string;
};

export type BackchannelLogoutResult =
  { ok: true; closed: number } | { ok: false; reason: "replayed" | "invalid" };

/** Closes the sessions a verified logout token names; `replayed` when its `jti` was seen. */
export type BackchannelLogout = (input: BackchannelLogoutInput) => Promise<BackchannelLogoutResult>;
