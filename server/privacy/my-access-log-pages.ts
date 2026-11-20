import { type AccessLogDay, accessLogDaysOf } from "../domain/privacy/access-log-days.ts";
import type { WithActor } from "../database/with-actor.ts";

import {
  type AccessLogCursor,
  MY_ACCESS_LOG_CURSOR_INVALID,
  MY_ACCESS_LOG_NOT_FOUND,
  MY_ACCESS_LOG_UNAUTHENTICATED,
  createMyAccessLogReader,
} from "../database/my-access-log.ts";

/**
 * DAN-294 (S-42; review FAIL c.6819070024, contract on #1836 c.6819193865):
 * "Prikaži starije dane" without client code and without a last page. The
 * address carries the cursor of the oldest row shown (`?prije=<opened_at>&
 * zapis=<id>`) and each request makes exactly one read from it, so every
 * opening is reachable by following the links (PRODUCT §5 rule 17).
 *
 * The cursor is the student's input: it passes the reader's own check
 * (calendar, microseconds, five-minute grid, a lower-case uuid) and may not
 * lie in the future; anything else reads the first page, never a query with
 * that cursor. The read takes only intervals strictly older than the cursor,
 * and an opening is written only into the current interval, so one written
 * between two requests shows on a fresh first page, never inside a
 * continuation; a row not older than the cursor is left out all the same.
 */

/** The query of the page as Next.js hands it; any other parameter, `stranica` too, is ignored. */
export interface AccessLogQuery {
  prije?: string | string[] | undefined;
  zapis?: string | string[] | undefined;
}

export type MyAccessLogPage =
  /** `next` is the cursor of an older page, null when there is none; `continued` when read from a cursor. */
  | { kind: "ok"; days: AccessLogDay[]; next: AccessLogCursor | null; continued: boolean }
  | { kind: "unauthorized" | "not_found" | "unavailable" };

/** PostgreSQL has no year zero: an instant before the first of year one is not a cursor. */
const FIRST_INSTANT = Date.parse("0001-01-01T00:00:00Z");

/** The cursor of the address, or null for the first page. */
function cursorParam(query: AccessLogQuery, now: number): AccessLogCursor | null {
  const { prije, zapis } = query;
  if (typeof prije !== "string" || typeof zapis !== "string") return null;
  // The reader checks the grid and the uuid (MY_ACCESS_LOG_CURSOR_INVALID);
  // here only what it does not: not in the future, not before year one.
  const at = Date.parse(prije);
  if (Number.isNaN(at) || at > now || at < FIRST_INSTANT) return null;
  return { beforeAt: prije, beforeId: zapis };
}

/** The address of the next older page. */
export function olderHref(here: string, next: AccessLogCursor): string {
  return `${here}?prije=${encodeURIComponent(next.beforeAt)}&zapis=${encodeURIComponent(next.beforeId)}`;
}

export async function readMyAccessLogPage(
  sessionToken: string | undefined,
  withActor: WithActor,
  documentId: string,
  query: AccessLogQuery,
  now: number = Date.now(),
): Promise<MyAccessLogPage> {
  const reader = createMyAccessLogReader(withActor);
  let cursor = cursorParam(query, now);
  let read = await reader.read(sessionToken, documentId, cursor);
  if (!read.ok && cursor !== null && read.error.code === MY_ACCESS_LOG_CURSOR_INVALID.code) {
    // An address the reader refuses is read as no cursor; nothing was sent to the database.
    cursor = null;
    read = await reader.read(sessionToken, documentId, null);
  }
  if (!read.ok) {
    if (read.error.code === MY_ACCESS_LOG_UNAUTHENTICATED.code) return { kind: "unauthorized" };
    if (read.error.code === MY_ACCESS_LOG_NOT_FOUND.code) return { kind: "not_found" };
    return { kind: "unavailable" };
  }
  // The reader has already left out what is not older than the cursor. The days
  // are built by the domain from rows, so the entries go back to the row shape.
  const days = accessLogDaysOf(
    read.value.entries.map((e) => ({
      entry_id: e.id,
      opened_at: new Date(e.at),
      reader_role: e.role,
      surface: e.surface,
      reader_given_name: e.reader?.givenName ?? null,
      reader_family_name: e.reader?.familyName ?? null,
    })),
  );
  if (days === null) return { kind: "unavailable" };
  return { kind: "ok", days, next: read.value.next, continued: cursor !== null };
}
