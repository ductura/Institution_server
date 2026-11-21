// SRV-1706 (plan M10.4, PRODUCT §5 rule 17, C4, D-274 MQ10): the reader of
// work.access.get, who opened the caller's own work and when, as Zagreb days
// of five-minute rows. One read of app.read_my_access_log through the port of
// server/database/my-access-log.ts (DAN-294), which checks every row, the
// cursor and the owner (another's, an unknown and a malformed work are
// MY_ACCESS_LOG_NOT_FOUND alike). That port knows the surfaces up to
// submitted_text; the declaration surface (20261208100000) is kept here from
// the row itself, so a declaration read shows as one, never as unknown.
import type { Result } from "../../domain/index.ts";
import { type AccessLogCursor, createMyAccessLogReader, type WithActor } from "../index.ts";

import { type WorkAccessDay, workAccessDaysOf } from "./days.ts";

export { workAccessDaysOf, zagrebDateOf } from "./days.ts";
export type { WorkAccessDay, WorkAccessRow, WorkAccessSurface } from "./days.ts";
export {
  NOT_A_PERSON_READ,
  WORK_READ_PATHS,
  type NotAPersonRead,
  type WorkReadPath,
} from "./work-read-paths.ts";

export type WorkAccessPage = {
  days: WorkAccessDay[];
  next: AccessLogCursor | null;
  /** Read from a checked cursor. */
  continued: boolean;
};

export type WorkAccessReader = {
  /**
   * One page for the session behind `token`. A cursor the port refuses, or
   * one after `now`, reads the first page with continued false, never an error.
   */
  read(
    token: string | undefined,
    documentId: string,
    cursor: AccessLogCursor | null,
    now?: number,
  ): Promise<Result<WorkAccessPage>>;
};

// The code of MY_ACCESS_LOG_CURSOR_INVALID (../my-access-log.ts), which the index does not export.
const CURSOR_INVALID = "MY_ACCESS_LOG_CURSOR_INVALID";

/** Surfaces of audit.access_log the port of my-access-log.ts does not know. */
const LATER_SURFACES = new Set(["declaration"]);

export function createWorkAccessReader(withActor: WithActor): WorkAccessReader {
  return {
    async read(token, documentId, cursor, now = Date.now()) {
      const later = new Map<string, "declaration">();
      const seeing: WithActor = (actorToken, run) =>
        withActor(actorToken, (tx) =>
          run({
            async query(text: string, values?: readonly unknown[]) {
              const result = await tx.query(text, values);
              for (const row of result.rows as Record<string, unknown>[]) {
                const { entry_id: id, surface } = row;
                if (
                  typeof id === "string" &&
                  typeof surface === "string" &&
                  LATER_SURFACES.has(surface)
                ) {
                  later.set(id, surface as "declaration");
                }
              }
              return result as never;
            },
          }),
        );
      const port = createMyAccessLogReader(seeing);
      const checked = cursor !== null && !(Date.parse(cursor.beforeAt) <= now) ? null : cursor;
      let read = await port.read(token, documentId, checked);
      let continued = checked !== null;
      if (!read.ok && read.error.code === CURSOR_INVALID) {
        later.clear();
        read = await port.read(token, documentId, null);
        continued = false;
      }
      if (!read.ok) return read;
      const entries = read.value.entries.map((entry) => {
        const surface = later.get(entry.id);
        return entry.surface === "unknown" && surface !== undefined ? { ...entry, surface } : entry;
      });
      return {
        ok: true,
        value: { days: workAccessDaysOf(entries), next: read.value.next, continued },
      };
    },
  };
}
