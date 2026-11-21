import { zagrebWall } from "../../domain/index.ts";
import type { AccessLogEntry, AccessLogSurface } from "../index.ts";

/**
 * SRV-1706 (plan M10.4, D-274 MQ10): the openings of one page as Europe/Zagreb
 * days, the newest day and the newest row first. Each stored opening stays one
 * row of five minutes: rows are never merged, and a day carries only its date
 * and its rows, never a count, a total or a duration. A day holds at least one
 * row. A repeated id is shown once.
 */

export type WorkAccessRole = AccessLogEntry["role"];
export type WorkAccessSurface = AccessLogSurface | "declaration";

export type WorkAccessRow = {
  id: string;
  /** The start of the window, as Date.toISOString gives it. */
  at: string;
  role: WorkAccessRole;
  surface: WorkAccessSurface;
  reader: AccessLogEntry["reader"];
};

export type WorkAccessDay = {
  /** Zagreb date, `2026-11-10`. */
  date: string;
  entries: WorkAccessRow[];
};

const pad2 = (value: number) => String(value).padStart(2, "0");
const pad4 = (value: number) => String(value).padStart(4, "0");

/** The Zagreb calendar date of an instant, `2026-11-10`. */
export function zagrebDateOf(epochMs: number): string {
  const wall = zagrebWall(epochMs);
  return `${pad4(wall.year)}-${pad2(wall.month)}-${pad2(wall.day)}`;
}

/** An entry of the port, with the surfaces the port does not know yet. */
export type WorkAccessEntry = Omit<AccessLogEntry, "surface"> & { surface: WorkAccessSurface };

export function workAccessDaysOf(entries: readonly WorkAccessEntry[]): WorkAccessDay[] {
  const unique = new Map<string, WorkAccessEntry>();
  for (const entry of entries) if (!unique.has(entry.id)) unique.set(entry.id, entry);
  const sorted = [...unique.values()].sort(
    (a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const days: WorkAccessDay[] = [];
  for (const entry of sorted) {
    const date = zagrebDateOf(entry.at);
    let day = days.at(-1);
    if (day?.date !== date) {
      day = { date, entries: [] };
      days.push(day);
    }
    day.entries.push({
      id: entry.id,
      at: new Date(entry.at).toISOString(),
      role: entry.role,
      surface: entry.surface,
      reader: entry.reader,
    });
  }
  return days;
}
