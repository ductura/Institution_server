// The port of the WebAuthn credential RPCs (DAN-840-3b; contract Ductus#1836
// c.6940273164), by the pattern of settings-writer.ts: one call is one
// withActor transaction of one statement; the database's own refusals become
// outcomes, every other error is thrown again as it is, and no row leaves this
// folder unchecked. Statuses, not AppError: the routes (840-3c, 3d) map a
// status to a problem code of their contract, so no user text lives here. The
// message of a database error is never read.
import { count } from "./open-work.ts";
import type { WithActor } from "./with-actor.ts";

/** A credential of the caller that is not revoked, as identity.webauthn_credential holds it. */
export type WebAuthnCredential = {
  readonly credentialId: Buffer;
  /** The COSE key of 840-2c, raw. */
  readonly publicKey: Buffer;
  readonly signCount: number;
};

type Refused<S extends string> = { readonly status: S };
/** No live session (ZD401), or a row of another form. */
type Common =
  Refused<"unauthenticated"> | { readonly status: "unavailable"; readonly reason: string };

export type WebAuthnListOutcome =
  { readonly status: "listed"; readonly credentials: readonly WebAuthnCredential[] } | Common;
/**
 * `forbidden` (ZD403) joins two causes: the account already has a key that is
 * not revoked, or there is no account; a route must not promise the first.
 * `conflict` (ZD409): the id is registered, to any account. In both outcomes
 * `invalid` is ZD422 or a counter outside 0..2^32-1, refused before any call.
 */
export type WebAuthnAddOutcome = Refused<"added" | "forbidden" | "conflict" | "invalid"> | Common;
/** `forbidden` (ZD403): an unknown, foreign or revoked key, one answer (C-23). */
export type WebAuthnUseOutcome =
  Refused<"used" | "forbidden" | "counter_not_increased" | "invalid"> | Common;

export type WebAuthnCredentials = {
  list(token: string): Promise<WebAuthnListOutcome>;
  add(token: string, credential: WebAuthnCredential): Promise<WebAuthnAddOutcome>;
  use(token: string, credentialId: Buffer, signCount: number): Promise<WebAuthnUseOutcome>;
};

const LIST_SQL =
  "SELECT c.credential_id, c.public_key, c.sign_count FROM identity.webauthn_credentials_for_actor() c";
const ADD_SQL = "SELECT identity.add_webauthn_credential($1::bytea, $2::bytea, $3::bigint) AS id";
const USE_SQL = "SELECT identity.use_webauthn_credential($1::bytea, $2::bigint) AS used";

const LIST_REFUSED = new Map([["ZD401", "unauthenticated"]] as const);
const ADD_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
] as const);
const USE_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD409", "counter_not_increased"],
  ["ZD422", "invalid"],
] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const malformed = (reason: string) => ({ status: "unavailable", reason }) as const;
// The bounds of the table's CHECKs.
const bytes = (value: unknown, max: number): value is Buffer =>
  Buffer.isBuffer(value) && value.length >= 1 && value.length <= max;
const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 32 - 1;
const has = (row: unknown, key: string): row is Record<string, unknown> =>
  row !== null && typeof row === "object" && Object.hasOwn(row, key);
const own = (row: unknown, key: string): unknown => (has(row, key) ? row[key] : undefined);

/** The rows of one statement, or the status of a refusal; any other error is thrown again. */
async function call<S extends string>(
  withActor: WithActor,
  token: string,
  sql: string,
  params: unknown[],
  refused: ReadonlyMap<string, S>,
): Promise<unknown[] | Refused<S>> {
  try {
    return await withActor(token, async (tx) => (await tx.query(sql, params)).rows);
  } catch (error) {
    let code: unknown;
    try {
      code = (error as { code?: unknown } | null)?.code;
    } catch {
      // A getter that throws: no code, so the error itself goes on.
    }
    const status = typeof code === "string" ? refused.get(code) : undefined;
    if (status === undefined) throw error;
    return { status };
  }
}

function credential(row: unknown): WebAuthnCredential | null {
  const credentialId = own(row, "credential_id");
  const publicKey = own(row, "public_key");
  const signCount = count(own(row, "sign_count"));
  if (!bytes(credentialId, 1023) || !bytes(publicKey, 4096) || !counter(signCount)) return null;
  return { credentialId, publicKey, signCount };
}

export function createWebAuthnCredentials(withActor: WithActor): WebAuthnCredentials {
  return {
    async list(token) {
      const rows = await call(withActor, token, LIST_SQL, [], LIST_REFUSED);
      if (!Array.isArray(rows)) return rows;
      const credentials = rows.map(credential);
      if (credentials.some((c) => c === null)) return malformed("list_malformed");
      return { status: "listed", credentials: credentials as WebAuthnCredential[] };
    },
    async add(token, { credentialId, publicKey, signCount }) {
      if (!counter(signCount)) return { status: "invalid" };
      const params = [credentialId, publicKey, String(signCount)];
      const rows = await call(withActor, token, ADD_SQL, params, ADD_REFUSED);
      if (!Array.isArray(rows)) return rows;
      const id = rows.length === 1 ? own(rows[0], "id") : undefined;
      if (typeof id !== "string" || !UUID.test(id)) return malformed("add_malformed");
      return { status: "added" };
    },
    async use(token, credentialId, signCount) {
      if (!counter(signCount)) return { status: "invalid" };
      const params = [credentialId, String(signCount)];
      const rows = await call(withActor, token, USE_SQL, params, USE_REFUSED);
      if (!Array.isArray(rows)) return rows;
      if (rows.length !== 1 || !has(rows[0], "used")) return malformed("use_malformed");
      return { status: "used" };
    },
  };
}
