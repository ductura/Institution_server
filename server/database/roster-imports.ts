// The port of institution.preview_roster_import and confirm_roster_import
// (SRV-ADMIN-2, NF-7 OA-10; migration 20261215100000): the administrator's
// two-step import of a course's students. In the form of admin-courses.ts:
// an outcome, never a throw; who may is the RPC's; the caller comes only from
// the session. One call is one withActor transaction of one statement. The
// database answers snake_case JSON; this is the one place it becomes
// camelCase.
import { call, type Refused, single, type Unavailable } from "./institution-courses.ts";
import type { WithActor } from "./with-actor.ts";

/** What the database says of a row it was sent. */
export const ROSTER_DATABASE_STATUSES = [
  "new",
  "already_enrolled",
  "unknown_account",
  "name_mismatch",
  "removed",
  "course_teacher",
] as const;
export type RosterDatabaseStatus = (typeof ROSTER_DATABASE_STATUSES)[number];

export type RosterImportCandidate = {
  readonly identifier: string;
  readonly givenName: string;
  readonly familyName: string;
};

/** ZD401, ZD403, ZD404 (course not the institution's), ZD422 by name. */
export type RosterPreviewOutcome =
  | {
      readonly status: "previewed";
      readonly importId: string;
      readonly expiresAt: string;
      /** One per candidate, in the order sent. */
      readonly statuses: readonly RosterDatabaseStatus[];
    }
  | Refused<"unauthenticated" | "forbidden" | "not_found" | "invalid">
  | Unavailable;

/** ZD401, ZD403, ZD404, ZD410 (expired) by name. */
export type RosterConfirmOutcome =
  | {
      readonly status: "confirmed";
      readonly enrolled: number;
      readonly alreadyEnrolled: number;
      readonly skipped: number;
      readonly alreadyConfirmed: boolean;
    }
  | Refused<"unauthenticated" | "forbidden" | "not_found" | "expired">
  | Unavailable;

export type RosterImports = {
  preview(
    token: string,
    courseId: string,
    source: string,
    candidates: readonly RosterImportCandidate[],
  ): Promise<RosterPreviewOutcome>;
  confirm(token: string, importId: string): Promise<RosterConfirmOutcome>;
};

const PREVIEW_SQL =
  "SELECT institution.preview_roster_import($1::uuid, $2::text, $3::jsonb) AS answer";
const CONFIRM_SQL = "SELECT institution.confirm_roster_import($1::uuid) AS answer";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUSES = new Set<string>(ROSTER_DATABASE_STATUSES);
const PREVIEW_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD422", "invalid"],
] as const);
const CONFIRM_REFUSED = new Map([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD410", "expired"],
] as const);

/** A plain object with exactly these own keys, or null. */
function exactly(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
  return value as Record<string, unknown>;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000;

export function createRosterImports(withActor: WithActor): RosterImports {
  return {
    async preview(token, courseId, source, candidates) {
      const sent = candidates.length;
      const read = (rows: unknown) => {
        const answer = exactly(single(rows, "answer"), ["import_id", "expires_at", "statuses"]);
        if (answer === null) return null;
        const { import_id: id, expires_at: expiresAt, statuses } = answer;
        if (typeof id !== "string" || !UUID.test(id)) return null;
        if (typeof expiresAt !== "string" || !INSTANT.test(expiresAt)) return null;
        if (!Array.isArray(statuses) || statuses.length !== sent) return null;
        if (!statuses.every((one) => typeof one === "string" && STATUSES.has(one))) return null;
        return {
          importId: id.toLowerCase(),
          expiresAt,
          statuses: statuses as RosterDatabaseStatus[],
        };
      };
      const rows = candidates.map(({ identifier, givenName, familyName }) => ({
        identifier,
        givenName,
        familyName,
      }));
      const outcome = await call(
        withActor,
        token,
        PREVIEW_SQL,
        [courseId, source, JSON.stringify(rows)],
        read,
        PREVIEW_REFUSED,
        "roster_preview_malformed",
      );
      return "value" in outcome ? { status: "previewed", ...outcome.value } : outcome;
    },

    async confirm(token, importId) {
      const read = (rows: unknown) => {
        const answer = exactly(single(rows, "answer"), [
          "enrolled",
          "already_enrolled",
          "skipped",
          "already_confirmed",
        ]);
        if (answer === null) return null;
        const { enrolled, already_enrolled: already, skipped, already_confirmed: again } = answer;
        if (!isCount(enrolled) || !isCount(already) || !isCount(skipped)) return null;
        if (typeof again !== "boolean") return null;
        return { enrolled, alreadyEnrolled: already, skipped, alreadyConfirmed: again };
      };
      const outcome = await call(
        withActor,
        token,
        CONFIRM_SQL,
        [importId],
        read,
        CONFIRM_REFUSED,
        "roster_confirm_malformed",
      );
      return "value" in outcome ? { status: "confirmed", ...outcome.value } : outcome;
    },
  };
}
