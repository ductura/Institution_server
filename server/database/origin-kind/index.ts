// SRV-0910 (Ductus#2052): the database port of the composition of a work by the
// kind of origin of its changes (20261213100300, app.work_origin_composition and
// the writers app.work_origin_record and app.work_origin_explain). One withActor
// transaction over one RPC, which decides whether the caller may read or write:
// the owner and the readers of the work read, only the owner writes; every
// refusal is one not_found (C-23). ZD401 is unauthenticated, ZD422 invalid,
// anything else unavailable. A row of an unexpected shape is unavailable too.
//
// SRV-KARTA-RASPON (Ductus#2055): the ranges of origin of a revision
// (20261218100000, app.work_origin_segments and the writer
// app.work_origin_segments_record); ZD409 (or the key, when two race) is a
// conflict: the ranges of a revision are recorded once.
import type { WithActor } from "../index.ts";

export const ORIGIN_KINDS = [
  "typed",
  "assistant_inserted",
  "assistant_match",
  "imported_file",
  "pasted_known",
  "pasted_unknown",
] as const;
export type OriginKindName = (typeof ORIGIN_KINDS)[number];

export type OriginPart = { readonly kind: OriginKindName; readonly percent: number };

type Failure = { readonly status: "unauthenticated" | "not_found" | "invalid" | "unavailable" };
export type OriginCompositionOutcome =
  { readonly status: "ok"; readonly parts: readonly OriginPart[] } | Failure;
export type OriginRecordOutcome = { readonly status: "ok"; readonly id: string } | Failure;
export type OriginExplainOutcome = { readonly status: "ok"; readonly explained: boolean } | Failure;

/** One range of origin of a revision (SRV-KARTA-RASPON, 20261218100000). */
export type OriginSegment = {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: OriginKindName;
  readonly segmentRef: string | null;
};
/** A range as the owner records it; changeId links it to its origin change. */
export type OriginSegmentInput = {
  readonly blockId: string;
  readonly start: number;
  readonly end: number;
  readonly kind: OriginKindName;
  readonly segmentRef?: string;
  readonly changeId?: string;
};
export type OriginSegmentsOutcome =
  | {
      readonly status: "ok";
      readonly revision: number | null;
      readonly segments: readonly OriginSegment[];
    }
  | Failure;
export type OriginSegmentsRecordOutcome =
  { readonly status: "ok"; readonly recorded: number } | { readonly status: "conflict" } | Failure;

export type OriginKind = {
  composition(token: string, documentId: string): Promise<OriginCompositionOutcome>;
  /** The student owner records a change; a paste is recorded as pasted_unknown. */
  record(
    token: string,
    documentId: string,
    kind: Exclude<OriginKindName, "pasted_known">,
    characters: number,
  ): Promise<OriginRecordOutcome>;
  /** pasted_unknown becomes pasted_known; the original kind stays recorded. */
  explain(token: string, documentId: string, changeId: string): Promise<OriginExplainOutcome>;
  /**
   * The ranges of the latest recorded revision at or below `revision` (any
   * when null); the owner and the readers read the same.
   */
  segments(
    token: string,
    documentId: string,
    revision: number | null,
  ): Promise<OriginSegmentsOutcome>;
  /** The student owner records the ranges of a saved revision, once. */
  recordSegments(
    token: string,
    documentId: string,
    revision: number,
    segments: readonly OriginSegmentInput[],
  ): Promise<OriginSegmentsRecordOutcome>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEGMENT_REF = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/u;

class Malformed extends Error {}

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function failureOf(thrown: unknown): Failure {
  if (thrown instanceof Malformed) return { status: "unavailable" };
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "not_found" };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function toParts(rows: readonly Record<string, unknown>[]): OriginPart[] {
  if (rows.length !== ORIGIN_KINDS.length) throw new Malformed();
  return rows.map((row, index) => {
    const percent = typeof row.percent === "string" ? Number(row.percent) : row.percent;
    if (
      row.kind !== ORIGIN_KINDS[index] ||
      typeof percent !== "number" ||
      !Number.isFinite(percent) ||
      percent < 0 ||
      percent > 100
    ) {
      throw new Malformed();
    }
    return { kind: ORIGIN_KINDS[index]!, percent };
  });
}

/** A whole number from a bigint column (pg sends it as a string). */
function wholeOf(value: unknown): number | null {
  const number =
    typeof value === "string" && /^(?:0|[1-9][0-9]{0,15})$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function toSegments(rows: readonly Record<string, unknown>[]): {
  revision: number | null;
  segments: OriginSegment[];
} {
  if (rows.length === 0) return { revision: null, segments: [] };
  const revision = wholeOf(rows[0]!.revision);
  if (revision === null) throw new Malformed();
  const segments = rows.map((row) => {
    const start = row.start;
    const end = row.end;
    const kind = ORIGIN_KINDS.find((candidate) => candidate === row.kind);
    const ref = row.segmentRef;
    if (
      wholeOf(row.revision) !== revision ||
      typeof row.blockId !== "string" ||
      !BLOCK_ID.test(row.blockId) ||
      typeof start !== "number" ||
      typeof end !== "number" ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > 10_000_000 ||
      kind === undefined ||
      (ref !== null && (typeof ref !== "string" || !SEGMENT_REF.test(ref)))
    ) {
      throw new Malformed();
    }
    return { blockId: row.blockId, start, end, kind, segmentRef: ref };
  });
  return { revision, segments };
}

export function createOriginKind(withActor: WithActor): OriginKind {
  return {
    async composition(token, documentId) {
      try {
        return await withActor(token, async (tx): Promise<OriginCompositionOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT kind, percent FROM app.work_origin_composition($1)",
              [documentId],
            )
          ).rows;
          return { status: "ok", parts: toParts(rows) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async record(token, documentId, kind, characters) {
      try {
        return await withActor(token, async (tx): Promise<OriginRecordOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT app.work_origin_record($1, $2, $3)::text AS id",
              [documentId, kind, characters],
            )
          ).rows;
          const id = rows[0]?.id;
          if (rows.length !== 1 || typeof id !== "string" || !UUID.test(id)) throw new Malformed();
          return { status: "ok", id };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async explain(token, documentId, changeId) {
      try {
        return await withActor(token, async (tx): Promise<OriginExplainOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT app.work_origin_explain($1, $2::uuid) AS explained",
              [documentId, changeId],
            )
          ).rows;
          const explained = rows[0]?.explained;
          if (rows.length !== 1 || typeof explained !== "boolean") throw new Malformed();
          return { status: "ok", explained };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async segments(token, documentId, revision) {
      try {
        return await withActor(token, async (tx): Promise<OriginSegmentsOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              'SELECT revision, block_id AS "blockId", start_at AS "start", end_at AS "end", kind, segment_ref AS "segmentRef" FROM app.work_origin_segments($1, $2::bigint)',
              [documentId, revision === null ? null : String(revision)],
            )
          ).rows;
          return { status: "ok", ...toSegments(rows) };
        });
      } catch (thrown) {
        return failureOf(thrown);
      }
    },
    async recordSegments(token, documentId, revision, segments) {
      try {
        return await withActor(token, async (tx): Promise<OriginSegmentsRecordOutcome> => {
          const rows = (
            await tx.query<Record<string, unknown>>(
              "SELECT app.work_origin_segments_record($1, $2::bigint, $3::jsonb) AS recorded",
              [documentId, String(revision), JSON.stringify(segments)],
            )
          ).rows;
          const recorded = rows[0]?.recorded;
          if (rows.length !== 1 || typeof recorded !== "number") throw new Malformed();
          return { status: "ok", recorded };
        });
      } catch (thrown) {
        const code = codeOf(thrown);
        // A second snapshot of the same revision, also when two race (the key).
        if (code === "ZD409" || code === "23505") return { status: "conflict" };
        return failureOf(thrown);
      }
    },
  };
}
