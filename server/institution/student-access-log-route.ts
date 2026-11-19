// SRV-11 (Ductus#2028 c.7008147932): the logic of student.access-log.get, who
// opened the caller's own work and when (PRODUCT §5 rule 17), over the port
// server/database/my-access-log.ts. The HTTP side (cookie, contract, problem
// bodies) is server/http/student-access-log.ts, since this area imports neither
// http nor contracts (docs/server-map.md §2). Port of the cursor handling of
// Ductus src/server/privacy/my-access-log-pages.ts at 4eaa776, with the
// contract's names: the query carries beforeAt and beforeId, and anything that
// is not exactly one of each, a checked instant on the grid that is not in the
// future and a lowercase uuid, reads the first page with continued false,
// never an error. Who asks and whose work it is come only from the session
// and the database: another's, an unknown and a malformed work read 404 alike.
import type { AccessLogCursor, MyAccessLogReader } from "../database/index.ts";

export type StudentAccessLogEntry = {
  id: string;
  /** The start of the five-minute window, as Date.toISOString gives it. */
  at: string;
  role: "teacher" | "mentor" | "seminar_teacher" | "unknown";
  surface: "live_view" | "process_summary" | "fast_path" | "replay" | "submitted_text" | "unknown";
  reader: { givenName: string; familyName: string } | null;
};

export type StudentAccessLogAnswer =
  | {
      status: 200;
      body: { entries: StudentAccessLogEntry[]; next: AccessLogCursor | null; continued: boolean };
    }
  | { status: 401 | 404 | 503 };

// The codes of MY_ACCESS_LOG_* (server/database/my-access-log.ts), compared by
// value: this area imports database only as types (docs/server-map.md §2).
const UNAUTHENTICATED = "MY_ACCESS_LOG_UNAUTHENTICATED";
const NOT_FOUND = "MY_ACCESS_LOG_NOT_FOUND";
const CURSOR_INVALID = "MY_ACCESS_LOG_CURSOR_INVALID";

/**
 * The cursor the query names, or null for the first page: exactly one
 * beforeAt and one beforeId, the instant not after `now`. The reader checks
 * the grid, year one and the uuid itself and answers CURSOR_INVALID otherwise.
 */
export function accessLogCursorOf(query: URLSearchParams, now: number): AccessLogCursor | null {
  const at = query.getAll("beforeAt");
  const id = query.getAll("beforeId");
  if (at.length !== 1 || id.length !== 1) return null;
  const [beforeAt, beforeId] = [at[0]!, id[0]!];
  const ms = Date.parse(beforeAt);
  if (!Number.isFinite(ms) || ms > now) return null;
  return { beforeAt, beforeId };
}

/** One page of the access log of `documentId` for the session behind `token`. */
export async function readStudentAccessLog(
  reader: MyAccessLogReader,
  token: string,
  documentId: string,
  query: URLSearchParams,
  now: number = Date.now(),
): Promise<StudentAccessLogAnswer> {
  const cursor = accessLogCursorOf(query, now);
  let read = await reader.read(token, documentId, cursor);
  let continued = cursor !== null;
  if (!read.ok && read.error.code === CURSOR_INVALID) {
    read = await reader.read(token, documentId, null);
    continued = false;
  }
  if (!read.ok) {
    if (read.error.code === UNAUTHENTICATED) return { status: 401 };
    if (read.error.code === NOT_FOUND) return { status: 404 };
    return { status: 503 };
  }
  const entries = read.value.entries.map((entry) => ({
    ...entry,
    at: new Date(entry.at).toISOString(),
  }));
  return { status: 200, body: { entries, next: read.value.next, continued } };
}
