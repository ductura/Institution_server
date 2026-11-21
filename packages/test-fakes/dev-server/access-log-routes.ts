// SRV-1706 (plan M10.4): who opened the student's own work, in days, in the
// dev fake. The rows are those of student.access-log.get from the invented
// access log; the day is the Europe/Zagreb date (CET or CEST by the EU rule),
// and a day carries only its date and its rows, never a count or a duration.
import type { Operations } from "../../contracts/index.ts";

import type { Handlers } from "./server.ts";

type Days = Operations["work.access.get"]["success"]["body"]["days"];

const HOUR = 3_600_000;
const lastSundayOneUtc = (year: number, month: number) => {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, last.getUTCDate() - last.getUTCDay(), 1);
};
const zagrebDate = (iso: string) => {
  const ms = Date.parse(iso);
  const year = new Date(ms).getUTCFullYear();
  const summer = ms >= lastSundayOneUtc(year, 2) && ms < lastSundayOneUtc(year, 9);
  return new Date(ms + (summer ? 2 : 1) * HOUR).toISOString().slice(0, 10);
};

export const ACCESS_LOG_HANDLERS: Handlers = {
  "work.access.get": ({ state, account, params, query, header }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || work.studentId !== account.id) return { error: "not_found" };
    const beforeAt = typeof query?.beforeAt === "string" ? query.beforeAt : null;
    const beforeId = typeof query?.beforeId === "string" ? query.beforeId : null;
    const continued = beforeAt !== null && beforeId !== null && !Number.isNaN(Date.parse(beforeAt));
    const days: Days = [];
    for (const e of state.accessLog
      .filter((e) => e.documentId === work.documentId && (!continued || e.at < (beforeAt ?? "")))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
      const date = zagrebDate(e.at);
      if (days.at(-1)?.date !== date) days.push({ date, entries: [] });
      const reader = state.accounts.find((a) => a.id === e.readerId);
      days.at(-1)!.entries.push({
        id: e.id,
        at: e.at,
        role: e.role,
        surface: e.surface,
        reader:
          reader === undefined
            ? null
            : { givenName: reader.givenName, familyName: reader.familyName },
      });
    }
    return { status: 200, body: { days, next: null, continued } };
  },
};
