// The port of the notice acknowledgment (contract
// institution.acknowledgment.post). Port of the database part of Ductus
// src/server/institution/acknowledgment-route.ts at 078c780 (DAN-306, #1502):
// institution.acknowledge_notice with the notice template version, then the
// stored fingerprint of the student's own row in the same transaction; a
// fingerprint other than the one the browser showed (or none, on a row from
// before fingerprints) rolls the acknowledgment back. ZD409 is told apart by
// conflictKind: the version still current means the notice changed.
// Changes are of form only: an outcome instead of a response, nothing is
// logged, no SQLSTATE leaves the port, and it never throws. The student and
// institution come only from the session; the write is the RPC's.
import type { WithActor } from "./with-actor.ts";

export type NoticeAcknowledgmentOutcome =
  | { readonly status: "acknowledged"; readonly acknowledgedAt: string }
  | {
      readonly status: "unauthenticated" | "forbidden" | "conflict" | "notice_changed";
    }
  | { readonly status: "unavailable"; readonly reason: string };

export type NoticeAcknowledgments = {
  acknowledge(
    token: string,
    input: {
      readonly assignmentId: string;
      readonly versionNo: number;
      readonly fingerprint: string;
      readonly templateVersion: number;
    },
  ): Promise<NoticeAcknowledgmentOutcome>;
};

const ACKNOWLEDGE_SQL =
  "SELECT institution.acknowledge_notice($1::uuid, $2::integer, $3::integer) AS acknowledged_at";
// The student's own row only: the policy limits it too, the predicate keeps
// the read from depending on that alone.
const STORED_FINGERPRINT_SQL = `SELECT notice_fingerprint FROM institution.notice_acknowledgment
  WHERE assignment_id = $1::uuid AND version_no = $2::integer AND student_id = app.current_user_id()`;
const CURRENT_VERSION_SQL =
  "SELECT current_version FROM institution.assignment WHERE id = $1::uuid";

// Thrown inside the transaction so that withActor rolls the acknowledgment
// back: the stored notice is not the one the browser showed.
const NOTICE_CHANGED: unique symbol = Symbol("notice changed");

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

export function createNoticeAcknowledgments(withActor: WithActor): NoticeAcknowledgments {
  /**
   * ZD409 comes both for a version that is no longer current and for a stored
   * acknowledgment of another text. Only the first is a version conflict; the
   * second says the notice changed. An unreadable version keeps "conflict".
   */
  async function conflictKind(
    token: string,
    assignmentId: string,
    versionNo: number,
  ): Promise<"conflict" | "notice_changed"> {
    try {
      const result = await withActor(token, (tx) =>
        tx.query<{ current_version: unknown }>(CURRENT_VERSION_SQL, [assignmentId]),
      );
      return result.rows[0]?.current_version === versionNo ? "notice_changed" : "conflict";
    } catch {
      return "conflict";
    }
  }

  return {
    async acknowledge(token, { assignmentId, versionNo, fingerprint, templateVersion }) {
      let at: unknown;
      try {
        at = await withActor(token, async (tx) => {
          const result = await tx.query<{ acknowledged_at: unknown }>(ACKNOWLEDGE_SQL, [
            assignmentId,
            versionNo,
            templateVersion,
          ]);
          const stored = await tx.query<{ notice_fingerprint: unknown }>(STORED_FINGERPRINT_SQL, [
            assignmentId,
            versionNo,
          ]);
          // #1502 B2/E3: another fingerprint, or none on a row from before
          // fingerprints, is not the text the student saw.
          if (stored.rows.length !== 1 || stored.rows[0]!.notice_fingerprint !== fingerprint) {
            throw NOTICE_CHANGED;
          }
          return result.rows[0]?.acknowledged_at;
        });
      } catch (thrown) {
        if (thrown === NOTICE_CHANGED) return { status: "notice_changed" };
        const code = codeOf(thrown);
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return { status: "forbidden" };
        if (code === "ZD409") return { status: await conflictKind(token, assignmentId, versionNo) };
        return { status: "unavailable", reason: "database_error" };
      }
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
        return { status: "unavailable", reason: "row_malformed" };
      }
      return { status: "acknowledged", acknowledgedAt: at.toISOString() };
    },
  };
}
