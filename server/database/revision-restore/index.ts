// INT-21 C: the database port of the record of a restore
// (app.record_revision_restore, 20261214100000). The student who owns a work
// names only the revision whose text it restored; the database records it
// against the lowest later revision of the same student with the same
// committed text that has no record yet, and never trusts a revision the
// client names for itself. Every refusal of access, an unknown and a
// malformed work are one not_found row (C-23). The answer names the revision
// the record is against, so a caller confirms only the restore it saved.
import type { WithActor } from "../index.ts";

export type RestoreOutcome = "recorded" | "already_recorded" | "no_matching_revision";

export type RestoreRecord =
  | {
      readonly status: "ok";
      readonly outcome: "recorded" | "already_recorded";
      /** The revision the record is against, always later than the one restored from. */
      readonly revision: number;
    }
  | { readonly status: "ok"; readonly outcome: "no_matching_revision" }
  | { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };

/** The owner records that the work restored the text of `fromRevision`. */
export type RevisionRestore = (
  token: string,
  documentId: string,
  fromRevision: number,
) => Promise<RestoreRecord>;

/** The last revision a restore can come from, as the function checks (ZD422 past it). */
export const RESTORE_MAX_FROM = Number.MAX_SAFE_INTEGER - 1;

const SQL =
  "SELECT outcome, revision::text AS revision FROM app.record_revision_restore($1, $2::bigint)";
const REVISION = /^[1-9][0-9]{0,15}$/;

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

export function createRevisionRestore(withActor: WithActor): RevisionRestore {
  return async (token, documentId, fromRevision) => {
    if (
      !Number.isSafeInteger(fromRevision) ||
      fromRevision < 1 ||
      fromRevision > RESTORE_MAX_FROM
    ) {
      return { status: "invalid" };
    }
    let rows: Record<string, unknown>[];
    try {
      rows = (
        await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(SQL, [documentId, fromRevision]),
        )
      ).rows;
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD422") return { status: "invalid" };
      return { status: "unavailable" };
    }
    const row = rows.length === 1 ? rows[0] : undefined;
    const outcome = row?.outcome;
    const revision = row?.revision;
    if (outcome === "not_found" && revision === null) return { status: "not_found" };
    if (outcome === "no_matching_revision" && revision === null) return { status: "ok", outcome };
    if (outcome !== "recorded" && outcome !== "already_recorded") return { status: "unavailable" };
    const number = typeof revision === "string" && REVISION.test(revision) ? Number(revision) : NaN;
    if (!Number.isSafeInteger(number) || number <= fromRevision) return { status: "unavailable" };
    return { status: "ok", outcome, revision: number };
  };
}
