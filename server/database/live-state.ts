// The port of the live view RPCs (contracts live.document.get and
// live.document.put). Port of the database part of Ductus
// src/server/collaboration/live-route.ts at 078c780 (the two statements,
// refusalFor and the checks of a row) in the form of the other ports: an
// outcome instead of a response, no SQLSTATE or message leaves it, nothing
// is logged here (Ductus logged a closed code), and it never throws. Who asks
// comes only from the session bound into withActor; the database decides
// access, and a teacher's read writes the access log inside read_live_state
// (PRODUCT §5 rule 17). Nothing here adds what the RPCs do not return.
import { createHash } from "node:crypto";

import type { WithActor } from "./with-actor.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const PUBLISH_SQL = "SELECT outcome, write_token FROM collaboration.publish_live_state($1, $2, $3)";
const READ_SQL = "SELECT outcome, content_hash, body FROM collaboration.read_live_state($1, $2)";

/** ZD401, ZD403 (read as a missing work, 404) and ZD422 by name, as Ductus refusalFor. */
type Refusal = { readonly status: "unauthenticated" | "not_found" | "invalid_document" };
type Unavailable = { readonly status: "unavailable"; readonly reason: string };

export type LivePublishOutcome =
  | { readonly status: "accepted" | "unchanged"; readonly token: string }
  /** The token is stale: the current one, null when nothing is published yet. */
  | { readonly status: "conflict"; readonly token: string | null }
  | Refusal
  | Unavailable;

export type LiveReadOutcome =
  | { readonly status: "empty" }
  /** The ETag sent is the state's (304); `submitted` marks the submitted revision. */
  | { readonly status: "not_modified"; readonly hash: string; readonly submitted: boolean }
  | {
      readonly status: "state";
      readonly hash: string;
      readonly bytes: Uint8Array;
      readonly submitted: boolean;
    }
  | Refusal
  | Unavailable;

export type LiveStates = {
  /** `expected` is the last write token, or null for the first write (If-None-Match: *). */
  publish(
    token: string,
    documentId: string,
    expected: string | null,
    text: string,
  ): Promise<LivePublishOutcome>;
  /** `known` is the hash of the ETag sent, or null. */
  read(token: string, documentId: string, known: string | null): Promise<LiveReadOutcome>;
};

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusalFor(thrown: unknown): Refusal | Unavailable {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid_document" };
  return { status: "unavailable", reason: "database_error" };
}

type Row = Record<string, unknown>;
const MALFORMED: Unavailable = { status: "unavailable", reason: "row_malformed" };

export function createLiveStates(withActor: WithActor): LiveStates {
  return {
    async publish(token, documentId, expected, text) {
      let rows: Row[];
      try {
        rows = (
          await withActor(token, (tx) => tx.query<Row>(PUBLISH_SQL, [documentId, expected, text]))
        ).rows;
      } catch (thrown) {
        return refusalFor(thrown);
      }
      const row = rows.length === 1 ? rows[0] : undefined;
      const written =
        typeof row?.write_token === "string" && UUID.test(row.write_token)
          ? row.write_token
          : undefined;
      if (row?.outcome === "accepted" || row?.outcome === "unchanged") {
        if (written !== undefined) return { status: row.outcome, token: written };
      } else if (row?.outcome === "conflict") {
        // No row yet answers a token with conflict and no current token.
        if (written !== undefined || row.write_token === null) {
          return { status: "conflict", token: written ?? null };
        }
      }
      return MALFORMED;
    },

    async read(token, documentId, known) {
      let rows: Row[];
      try {
        rows = (await withActor(token, (tx) => tx.query<Row>(READ_SQL, [documentId, known]))).rows;
      } catch (thrown) {
        return refusalFor(thrown);
      }
      const row = rows.length === 1 ? rows[0] : undefined;
      const hash =
        typeof row?.content_hash === "string" && HASH.test(row.content_hash)
          ? row.content_hash
          : undefined;
      if (row?.outcome === "empty") return { status: "empty" };
      if (row?.outcome === "unchanged" && hash !== undefined && hash === known) {
        return { status: "not_modified", hash, submitted: false };
      }
      // After the submission the bytes are the submitted revision, never the live state.
      const submitted = row?.outcome === "submitted";
      if (submitted && row.body === null && hash !== undefined && hash === known) {
        return { status: "not_modified", hash, submitted: true };
      }
      if (
        (row?.outcome === "state" || submitted) &&
        hash !== undefined &&
        typeof row?.body === "string"
      ) {
        const bytes = Buffer.from(row.body, "utf8");
        // The database keeps the hash of these bytes; a row that disagrees is not served.
        if (createHash("sha256").update(bytes).digest("hex") === hash) {
          return { status: "state", hash, bytes: new Uint8Array(bytes), submitted };
        }
      }
      // The submitted text cannot be shown; the live state is never served in its place.
      if (row?.outcome === "unavailable")
        return { status: "unavailable", reason: "submitted_unavailable" };
      return MALFORMED;
    },
  };
}
