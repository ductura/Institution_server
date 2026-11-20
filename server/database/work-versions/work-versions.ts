// The versions of one work, for its owner and the teacher of its assignment
// (SRV-9A, Ductus#2028; Ductus docs/PRODUCT.md §5 rule 7, N-11): the saved
// points of the document (checkpoints) and its submission, newest first, one
// page at a time. Who asks comes only from the session token bound into
// withActor; app.read_work_versions decides access with the replay's
// relation (collaboration.document_scope and actor_role), answers one
// not_found row for every refusal and a missing work alike (C-23), cuts the
// checkpoints at the submitted revision as the replay does and writes the
// teacher's row of the access log in the same transaction. Nothing here
// writes. The answer names no text, hash, submission id or exact time: a
// version has a kind, a revision and a whole minute (D-24), and a submission
// whether it came after the deadline. Every row is checked before it leaves
// this folder; one it cannot vouch for answers for the whole page.
import type { WithActor } from "../index.ts";

/** The most versions in one page; the function returns one more to tell that more follow. */
export const WORK_VERSIONS_PAGE_SIZE = 200;

export type WorkVersionsItem =
  | { readonly kind: "checkpoint"; readonly revision: number; readonly savedMinute: string }
  | {
      readonly kind: "submission";
      readonly revision: number;
      /** The request instant on a whole minute (D-24). */
      readonly savedMinute: string;
      readonly afterDeadline: boolean;
    };

export type WorkVersionsPage =
  | {
      readonly status: "found";
      /** Newest first: revision descending, a submission before the checkpoint of its revision. */
      readonly versions: readonly WorkVersionsItem[];
      /** The `beforeRevision` of the next page, or null when this is the last one. */
      readonly nextBeforeRevision: number | null;
    }
  | { readonly status: "not_found" | "unauthenticated" | "invalid_input" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { readonly status: "unavailable"; readonly reason: "rows_malformed" };

/** One page of the versions of `documentId` for the session `token`. */
export type WorkVersionsReader = (
  token: string,
  documentId: string,
  beforeRevision: number | null,
) => Promise<WorkVersionsPage>;

type Row = Record<string, unknown>;

const SQL = `SELECT outcome, kind, revision::text AS revision, saved_minute AS "savedMinute",
    after_deadline AS "afterDeadline"
  FROM app.read_work_versions($1, $2::bigint)`;
// int8 travels as text; revision 0 is the empty document and never a version.
const REVISION = /^[1-9][0-9]{0,15}$/;
const MALFORMED = { status: "unavailable", reason: "rows_malformed" } as const;

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** null, or a safe integer of at least 2: below 2 no version can follow. */
function isBeforeRevision(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 2);
}

/** One `found` row as a version, or null when it is not what the function returns. */
export function versionOf(row: Row): WorkVersionsItem | null {
  const { kind, savedMinute: minute, afterDeadline } = row;
  if (row.outcome !== "found" || typeof row.revision !== "string") return null;
  if (!REVISION.test(row.revision)) return null;
  const revision = Number(row.revision);
  if (
    !Number.isSafeInteger(revision) ||
    !(minute instanceof Date) ||
    !Number.isFinite(minute.getTime()) ||
    minute.getTime() % 60_000 !== 0
  ) {
    return null;
  }
  const savedMinute = minute.toISOString();
  if (kind === "checkpoint" && afterDeadline === null) return { kind, revision, savedMinute };
  if (kind === "submission" && typeof afterDeadline === "boolean") {
    return { kind, revision, savedMinute, afterDeadline };
  }
  return null;
}

/** Order inside one revision: the submission first. */
const RANK = { submission: 0, checkpoint: 1 } as const;

/** True when `next` comes strictly after `previous` in the page order. */
function follows(previous: WorkVersionsItem, next: WorkVersionsItem): boolean {
  if (next.revision !== previous.revision) return next.revision < previous.revision;
  return RANK[next.kind] > RANK[previous.kind];
}

/**
 * The rows of one call as a page. A single `not_found` or `empty` row is that
 * answer; otherwise every row must be a version below `beforeRevision`, in
 * strict page order, with at most one submission and at most one row beyond
 * the page size. The extra row only says that more follow: the page ends
 * before the revision it shares with the last kept row, so a revision is
 * never split across two pages.
 */
export function pageOf(rows: readonly Row[], beforeRevision: number | null): WorkVersionsPage {
  if (rows.length === 1 && rows[0]?.outcome === "not_found") return { status: "not_found" };
  if (rows.length === 1 && rows[0]?.outcome === "empty") {
    return { status: "found", versions: [], nextBeforeRevision: null };
  }
  if (rows.length === 0 || rows.length > WORK_VERSIONS_PAGE_SIZE + 1) return MALFORMED;
  const versions: WorkVersionsItem[] = [];
  for (const row of rows) {
    const version = versionOf(row);
    const previous = versions.at(-1);
    if (
      version === null ||
      (beforeRevision !== null && version.revision >= beforeRevision) ||
      (previous !== undefined && !follows(previous, version)) ||
      (version.kind === "submission" && versions.some((seen) => seen.kind === "submission"))
    ) {
      return MALFORMED;
    }
    versions.push(version);
  }
  if (versions.length <= WORK_VERSIONS_PAGE_SIZE) {
    return { status: "found", versions, nextBeforeRevision: null };
  }
  const boundary = (versions.at(-1) as WorkVersionsItem).revision;
  const kept = versions.slice(0, WORK_VERSIONS_PAGE_SIZE).filter((v) => v.revision !== boundary);
  return {
    status: "found",
    versions: kept,
    nextBeforeRevision: (kept.at(-1) as WorkVersionsItem).revision,
  };
}

/** The reader over main's application withActor; the token is only presented, never a parameter. */
export function createWorkVersionsReader(withActor: WithActor): WorkVersionsReader {
  return async (token, documentId, beforeRevision) => {
    if (!isBeforeRevision(beforeRevision)) return { status: "invalid_input" };
    let rows: Row[];
    try {
      rows = (await withActor(token, (tx) => tx.query<Row>(SQL, [documentId, beforeRevision])))
        .rows;
    } catch (error) {
      // ZD401: no open session (DAN-85). Anything else is the route's 503.
      if (codeOf(error) === "ZD401") return { status: "unauthenticated" };
      throw error;
    }
    return pageOf(rows, beforeRevision);
  };
}
