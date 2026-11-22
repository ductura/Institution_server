// SRV-0910 (Ductus#2052): the database port of the composition of a work by the
// kind of origin of its changes (20261213100300, app.work_origin_composition and
// the writers app.work_origin_record and app.work_origin_explain). One withActor
// transaction over one RPC, which decides whether the caller may read or write:
// the owner and the readers of the work read, only the owner writes; every
// refusal is one not_found (C-23). ZD401 is unauthenticated, ZD422 invalid,
// anything else unavailable. A row of an unexpected shape is unavailable too.
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
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  };
}
