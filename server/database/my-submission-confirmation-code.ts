// SRV-KOD-POTVRDE (Ductus#2059, S-08): the "Kod potvrde" of the caller's own
// submission, for student.submission-confirmation-code.get. One withActor
// transaction, one STABLE statement over app.my_submission_confirmation_code,
// nothing written. The session determines the caller; another's, an unknown or
// a malformed assignment is not_found (C-23). code is null while there is no
// bound receipt. A row that is not exactly one of the two shapes, or a code
// outside the alphabet without I, L, O and U, is ROW_MALFORMED.
import type { Result } from "../domain/index.ts";

import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_NOT_FOUND,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
} from "./my-submission-state.ts";
import type { WithActor } from "./with-actor.ts";

export type MySubmissionConfirmationCodeReader = {
  /** The code, or null before the receipt is bound; not_found for anyone else's assignment. */
  read(token: string | undefined, assignmentId: string): Promise<Result<string | null>>;
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const SQL = "SELECT outcome, code FROM app.my_submission_confirmation_code($1::uuid)";

function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function resultOf(rows: unknown): Result<string | null> {
  const malformed = { ok: false, error: MY_SUBMISSION_STATE_ROW_MALFORMED } as const;
  if (!Array.isArray(rows) || rows.length !== 1) return malformed;
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null) return malformed;
  const outcome = Object.hasOwn(row, "outcome")
    ? (row as Record<string, unknown>)["outcome"]
    : null;
  const code = Object.hasOwn(row, "code") ? (row as Record<string, unknown>)["code"] : undefined;
  if (outcome === "not_found") {
    return code === null ? { ok: false, error: MY_SUBMISSION_STATE_NOT_FOUND } : malformed;
  }
  if (outcome !== "found") return malformed;
  if (code === null) return { ok: true, value: null };
  return typeof code === "string" && CODE.test(code) ? { ok: true, value: code } : malformed;
}

export function createMySubmissionConfirmationCodeReader(
  withActor: WithActor,
): MySubmissionConfirmationCodeReader {
  return {
    async read(token, assignmentId) {
      if (token === undefined || !TOKEN.test(token)) {
        return { ok: false, error: MY_SUBMISSION_STATE_UNAUTHENTICATED };
      }
      if (!UUID.test(assignmentId)) return { ok: false, error: MY_SUBMISSION_STATE_NOT_FOUND };
      let rows: unknown;
      try {
        rows = await withActor(token, async (tx) => (await tx.query(SQL, [assignmentId])).rows);
      } catch (thrown) {
        return {
          ok: false,
          error:
            codeOf(thrown) === "ZD401"
              ? MY_SUBMISSION_STATE_UNAUTHENTICATED
              : MY_SUBMISSION_STATE_DATABASE_ERROR,
        };
      }
      try {
        return resultOf(rows);
      } catch {
        return { ok: false, error: MY_SUBMISSION_STATE_ROW_MALFORMED };
      }
    },
  };
}
