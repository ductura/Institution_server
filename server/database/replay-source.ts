// The source of one replay (DAN-818, VS-1 narrow cut, step 4). Port of Ductus
// src/server/evidence/replay-route.ts sessionReplaySource and
// src/server/projection/process-summary.ts sourceResult at 333e163, without a
// change of logic: app.read_replay_source and app.read_replay_checkpoints run
// under withActor, so access is decided by the database (RLS, C-23) and the
// institution of a found record comes from its row, never from the request.
// Rows become camelCase only here.
import { isInstitutionId, isSha256Hex } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

export type ReplayHead = { segmentHash: string; segmentCount: number };

export type ReplaySourceResult =
  | {
      status: "found";
      institutionId: string;
      evidencePackageId: string;
      /** The last listed segment, or null for a record with none. */
      head: ReplayHead | null;
      segmentHashes: string[];
    }
  | { status: "not_found" | "unauthenticated" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { status: "unavailable"; reason: string };

export type ReplayCheckpointsResult =
  | { status: "found"; texts: ReadonlyMap<string, string> }
  | { status: "unauthenticated" }
  | { status: "unavailable"; reason: string };

/**
 * Where a replay is read from, bound to one session. One record for every
 * viewer, refusal that looks like absence, and the submission cut. A hash
 * with no checkpoint text is absent from the map, never an error.
 */
export type ReplaySource = {
  readSource(documentId: string): Promise<ReplaySourceResult>;
  /** `contentHashes` are 1 to 512 distinct lowercase SHA-256 hex strings. */
  readCheckpoints(
    documentId: string,
    contentHashes: readonly string[],
  ): Promise<ReplayCheckpointsResult>;
};

const SOURCE_SQL =
  "SELECT outcome, institution_id, evidence_package_id, segment_hashes FROM app.read_replay_source($1)";
const CHECKPOINTS_SQL =
  "SELECT content_hash, body FROM app.read_replay_checkpoints($1, $2::text[])";
const PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;

type Row = Record<string, unknown>;

/** ZD401: no open session (DAN-85). Anything else is rethrown. */
function isUnauthenticated(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ZD401");
}

/** The one row of app.read_replay_source, checked before it leaves this folder. */
export function sourceResult(rows: readonly Row[]): ReplaySourceResult {
  const malformed = { status: "unavailable", reason: "source_malformed" } as const;
  if (rows.length !== 1) return malformed;
  const row = rows[0] as Row;
  const outcome = row.outcome;
  const institutionId = row.institution_id;
  const packageId = row.evidence_package_id;
  const hashes = row.segment_hashes;
  if (outcome === "not_found") return { status: "not_found" };
  if (outcome === "unavailable") return { status: "unavailable", reason: "source_unavailable" };
  if (
    outcome !== "found" ||
    !isInstitutionId(institutionId) ||
    typeof packageId !== "string" ||
    !PACKAGE_ID.test(packageId) ||
    !Array.isArray(hashes) ||
    !hashes.every((hash) => isSha256Hex(hash))
  ) {
    return malformed;
  }
  const segmentHashes = [...(hashes as string[])];
  const last = segmentHashes.at(-1);
  return {
    status: "found",
    institutionId,
    evidencePackageId: packageId,
    head: last === undefined ? null : { segmentHash: last, segmentCount: segmentHashes.length },
    segmentHashes,
  };
}

/** The source of one session's token; the token is only presented, never a parameter. */
export function createReplaySource(withActor: WithActor, token: string): ReplaySource {
  return {
    async readSource(documentId) {
      let rows: Row[];
      try {
        rows = (await withActor(token, (tx) => tx.query<Row>(SOURCE_SQL, [documentId]))).rows;
      } catch (error) {
        if (isUnauthenticated(error)) return { status: "unauthenticated" };
        throw error;
      }
      return sourceResult(rows);
    },
    async readCheckpoints(documentId, contentHashes) {
      let rows: Row[];
      try {
        rows = (
          await withActor(token, (tx) =>
            tx.query<Row>(CHECKPOINTS_SQL, [documentId, [...contentHashes]]),
          )
        ).rows;
      } catch (error) {
        if (isUnauthenticated(error)) return { status: "unauthenticated" };
        throw error;
      }
      const texts = new Map<string, string>();
      for (const row of rows) {
        const hash = row.content_hash;
        if (typeof hash !== "string" || typeof row.body !== "string" || texts.has(hash)) {
          return { status: "unavailable", reason: "checkpoints_malformed" };
        }
        texts.set(hash, row.body);
      }
      return { status: "found", texts };
    },
  };
}
