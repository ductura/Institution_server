// The student's own access log of one work, first page (DAN-859-1; contract
// Ductus#1836 c.6943482512). Port of readMyAccessLog in Ductus
// src/server/privacy/my-access-log.ts and of the row check in
// src/domain/privacy/access-log-days.ts at b36c82b. One withActor transaction,
// one STABLE statement, nothing written. Who asks comes only from the session
// token; the database decides whose work it is and answers ZD403 for another
// person's, an unknown or a malformed work alike, so all three read not_found
// (pgTAP 115). Deviations, as in open-work.ts: `status` instead of `kind`,
// nothing logged here (a closed reason instead), a throwing `code` getter is
// `unknown`, and the rows stay in the order read; days and the cursor of a
// continuation come in DAN-859-2.

import type { WithActor } from "./with-actor.ts";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const WINDOW_MS = 5 * 60_000;
const NAME_MAX = 255;
const ROLES = new Set(["teacher", "mentor", "seminar_teacher"]);
const SURFACES = new Set(["live_view", "process_summary", "fast_path", "replay", "submitted_text"]);
const SQL = "SELECT * FROM app.read_my_access_log($1, $2, $3, $4)";

/** Openings per page; the RPC ends a page on a whole window, so a page can hold a few more. */
export const ACCESS_LOG_PAGE = 50;

export type AccessLogRole = "teacher" | "mentor" | "seminar_teacher" | "unknown";
export type AccessLogSurface =
  "live_view" | "process_summary" | "fast_path" | "replay" | "submitted_text" | "unknown";

export type AccessLogEntry = {
  id: string;
  /** Epoch milliseconds of the window's start; for order only, never shown. */
  at: number;
  role: AccessLogRole;
  surface: AccessLogSurface;
  /** Null when the reader has no name pair; never a stand-in. */
  reader: { givenName: string; familyName: string } | null;
};

/** Where the next page starts: the oldest row shown, as the RPC takes it. */
export type AccessLogCursor = { beforeAt: string; beforeId: string };

export type MyAccessLogRead =
  | { status: "ok"; entries: AccessLogEntry[]; next: AccessLogCursor | null }
  | { status: "unauthenticated" | "not_found" }
  /** The reason is a closed code for the server's own record, never for the answer. */
  | { status: "unavailable"; reason: string };

export type MyAccessLogReader = {
  read(token: string | undefined, documentId: string): Promise<MyAccessLogRead>;
};

type Row = Record<string, unknown>;

/** A document id as `evidence.document` allows it: 1 to 256 characters, trimmed, no control characters. */
function isDocumentId(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  );
}

function isName(value: unknown): value is string {
  // Code points, as length() in the database counts.
  return typeof value === "string" && value.length >= 1 && [...value].length <= NAME_MAX;
}

const ZONED_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Milliseconds of an ISO instant that names its zone, else NaN; never rounded, never rolled over. */
function zonedInstantOf(value: string): number {
  const match = ZONED_INSTANT.exec(value);
  if (match === null || /[1-9]/.test(match[7]?.slice(3) ?? "")) return Number.NaN;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part ?? "0")) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return Number.NaN;
  if (hour > 23 || minute > 59 || second > 59) return Number.NaN;
  return Date.parse(value);
}

function epochOf(value: unknown): number | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? zonedInstantOf(value)
        : Number.NaN;
  // The writer bins to five minutes (date_bin from 2000-01-01 UTC).
  return Number.isFinite(ms) && ms % WINDOW_MS === 0 ? ms : null;
}

/** One row of the read as an entry, or null when it is not what the read returns. */
function entryOf(row: Row): AccessLogEntry | null {
  const { entry_id: id, reader_role: role, surface } = row;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const at = epochOf(row.opened_at);
  if (at === null) return null;
  let reader: AccessLogEntry["reader"];
  if (isName(row.reader_given_name) && isName(row.reader_family_name)) {
    reader = { givenName: row.reader_given_name, familyName: row.reader_family_name };
  } else if (row.reader_given_name === null && row.reader_family_name === null) {
    reader = null;
  } else {
    return null;
  }
  return {
    id,
    at,
    role: typeof role === "string" && ROLES.has(role) ? (role as AccessLogRole) : "unknown",
    surface:
      typeof surface === "string" && SURFACES.has(surface)
        ? (surface as AccessLogSurface)
        : "unknown",
    reader,
  };
}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): string | undefined {
  try {
    const code = thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createMyAccessLogReader(withActor: WithActor): MyAccessLogReader {
  return {
    async read(token, documentId) {
      if (token === undefined || !TOKEN.test(token)) return { status: "unauthenticated" };
      if (!isDocumentId(documentId)) return { status: "not_found" };
      let rows: Row[];
      try {
        rows = await withActor(
          token,
          async (tx) => (await tx.query<Row>(SQL, [documentId, ACCESS_LOG_PAGE, null, null])).rows,
        );
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return { status: "not_found" };
        return {
          status: "unavailable",
          reason: code !== undefined && SQLSTATE.test(code) ? code : "unknown",
        };
      }
      const entries: AccessLogEntry[] = [];
      for (const row of rows) {
        const entry = entryOf(row);
        if (entry === null) return { status: "unavailable", reason: "row_malformed" };
        entries.push(entry);
      }
      let next: AccessLogCursor | null = null;
      if (entries.length >= ACCESS_LOG_PAGE) {
        // The oldest of the page, by the order the read returns (opened_at, then id, descending).
        const oldest = entries.reduce((a, b) =>
          b.at < a.at || (b.at === a.at && b.id < a.id) ? b : a,
        );
        next = { beforeAt: new Date(oldest.at).toISOString(), beforeId: oldest.id };
      }
      return { status: "ok", entries, next };
    },
  };
}
