// SRV-1305: legal holds of the actor's institution. The RPCs check that the
// actor is a confirmed institution admin; the one who placed a hold can never
// release it (ZD403). Inputs are validated by the database, which answers
// ZD422 for an invalid one and ZD404 for a subject outside the institution.
import type { WithActor } from "../index.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT_TYPES = ["work", "student", "assignment"] as const;

export type LegalHoldSubjectType = (typeof SUBJECT_TYPES)[number];

export type LegalHold = {
  holdId: string;
  subjectType: LegalHoldSubjectType;
  subjectId: string;
  caseReference: string;
  placedBy: string;
  placedAt: string;
  /** Null both while the hold stands and after an operator released it. */
  releasedBy: string | null;
  releasedAt: string | null;
};

type Refusal = {
  status: "unauthenticated" | "forbidden" | "not_found" | "conflict" | "invalid" | "unavailable";
};

export type LegalHolds = {
  list(token: string): Promise<{ status: "ok"; holds: LegalHold[] } | Refusal>;
  place(
    token: string,
    hold: { subjectType: string; subjectId: string; caseReference: string },
  ): Promise<{ status: "ok"; holdId: string } | Refusal>;
  release(
    token: string,
    holdId: string,
    reason: string,
  ): Promise<{ status: "ok"; holdId: string; releasedAt: string } | Refusal>;
};

const REFUSALS = new Map<unknown, Refusal["status"]>([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD409", "conflict"],
  ["ZD422", "invalid"],
]);

function refusal(error: unknown): Refusal {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return { status: REFUSALS.get(code) ?? "unavailable" };
}

function instant(value: unknown): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

function holdOf(row: Record<string, unknown>): LegalHold | undefined {
  const placedAt = instant(row.placedAt);
  const releasedAt = row.releasedAt === null ? null : instant(row.releasedAt);
  const releasedBy = row.releasedBy;
  if (
    typeof row.holdId !== "string" ||
    !SUBJECT_TYPES.includes(row.subjectType as LegalHoldSubjectType) ||
    typeof row.subjectId !== "string" ||
    typeof row.caseReference !== "string" ||
    typeof row.placedBy !== "string" ||
    placedAt === undefined ||
    releasedAt === undefined ||
    !(releasedBy === null || typeof releasedBy === "string") ||
    (releasedBy !== null && releasedAt === null)
  ) {
    return undefined;
  }
  return {
    holdId: row.holdId,
    subjectType: row.subjectType as LegalHoldSubjectType,
    subjectId: row.subjectId,
    caseReference: row.caseReference,
    placedBy: row.placedBy,
    placedAt,
    releasedBy,
    releasedAt,
  };
}

export function createLegalHolds(withActor: WithActor): LegalHolds {
  async function ask(token: string, sql: string, params: unknown[]) {
    return (await withActor(token, (tx) => tx.query<Record<string, unknown>>(sql, params))).rows;
  }

  return {
    async list(token) {
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(
          token,
          `SELECT hold_id AS "holdId", subject_type AS "subjectType", subject_id AS "subjectId",
                  case_reference AS "caseReference", placed_by AS "placedBy",
                  placed_at AS "placedAt", released_by AS "releasedBy", released_at AS "releasedAt"
             FROM app.legal_holds()`,
          [],
        );
      } catch (error) {
        return refusal(error);
      }
      const holds: LegalHold[] = [];
      for (const row of rows) {
        const hold = holdOf(row);
        if (!hold) return { status: "unavailable" };
        holds.push(hold);
      }
      return { status: "ok", holds };
    },

    async place(token, { subjectType, subjectId, caseReference }) {
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(token, 'SELECT app.place_legal_hold($1, $2, $3) AS "holdId"', [
          subjectType,
          subjectId,
          caseReference,
        ]);
      } catch (error) {
        return refusal(error);
      }
      const holdId = rows.length === 1 ? rows[0]!.holdId : undefined;
      if (typeof holdId !== "string" || !UUID.test(holdId)) return { status: "unavailable" };
      return { status: "ok", holdId };
    },

    async release(token, holdId, reason) {
      holdId = holdId.toLowerCase();
      if (!UUID.test(holdId)) return { status: "not_found" };
      let rows: Record<string, unknown>[];
      try {
        rows = await ask(token, 'SELECT app.release_legal_hold($1::uuid, $2) AS "releasedAt"', [
          holdId,
          reason,
        ]);
      } catch (error) {
        return refusal(error);
      }
      const releasedAt = rows.length === 1 ? instant(rows[0]!.releasedAt) : undefined;
      if (releasedAt === undefined) return { status: "unavailable" };
      return { status: "ok", holdId, releasedAt };
    },
  };
}
