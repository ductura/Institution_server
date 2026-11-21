// SRV-1706 (plan M10.4, D-274 MQ10): the reader of work.access.get over a
// stand-in transaction. Every token, id and name below is invented.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import {
  createWorkAccessReader,
  NOT_A_PERSON_READ,
  WORK_READ_PATHS,
  workAccessDaysOf,
  zagrebDateOf,
} from "./index.ts";

const TOKEN = "izmisljeni-token-dnevnika-pristupa-00000001";
const DOC = "izmisljeni-rad-0001";
const id = (n: number) => `00000000-0000-4000-8000-0000000017${String(n).padStart(2, "0")}`;
const row = (n: number, at: string, surface = "live_view") => ({
  entry_id: id(n),
  opened_at: at,
  surface,
  reader_role: "teacher",
  reader_given_name: "Izmišljena",
  reader_family_name: "Nastavnica",
});

function reader(pages: Record<string, unknown>[][] | { code: string }) {
  const seen: (readonly unknown[] | undefined)[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(_text, values) {
        seen.push(values);
        if (!Array.isArray(pages)) throw Object.assign(new Error("izmisljeno"), pages);
        const rows = pages.shift() ?? [];
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { read: createWorkAccessReader(withActor).read, seen };
}

describe("workAccessDaysOf", () => {
  it("groups five-minute rows into Zagreb days, newest first, with no count or duration", () => {
    const at = (iso: string) => Date.parse(iso);
    const entry = (n: number, iso: string) => ({
      id: id(n),
      at: at(iso),
      role: "teacher" as const,
      surface: "replay" as const,
      reader: null,
    });
    const days = workAccessDaysOf([
      entry(1, "2026-11-09T19:55:00.000Z"),
      // 00:30 on 10 November in Zagreb (UTC+1).
      entry(2, "2026-11-09T23:30:00.000Z"),
      entry(3, "2026-11-10T13:10:00.000Z"),
      entry(3, "2026-11-10T13:10:00.000Z"),
      // The same window, another reader: two rows, never merged.
      entry(4, "2026-11-10T13:10:00.000Z"),
    ]);
    expect(days.map((d) => [d.date, d.entries.map((e) => e.id)])).toEqual([
      ["2026-11-10", [id(4), id(3), id(2)]],
      ["2026-11-09", [id(1)]],
    ]);
    expect(Object.keys(days[0]!).sort()).toEqual(["date", "entries"]);
    expect(Object.keys(days[0]!.entries[0]!).sort()).toEqual([
      "at",
      "id",
      "reader",
      "role",
      "surface",
    ]);
    expect(days[1]!.entries[0]!.at).toBe("2026-11-09T19:55:00.000Z");
    expect(workAccessDaysOf([])).toEqual([]);
  });

  it("dates by the Zagreb clock in summer time too", () => {
    expect(zagrebDateOf(Date.parse("2026-07-01T21:55:00Z"))).toBe("2026-07-01");
    expect(zagrebDateOf(Date.parse("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
    expect(zagrebDateOf(Date.parse("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});

describe("createWorkAccessReader", () => {
  it("reads one page as days and keeps the declaration surface", async () => {
    const { read } = reader([
      [
        row(1, "2026-11-10T13:10:00+00:00", "declaration"),
        row(2, "2026-11-10T08:05:00+00:00", "process_summary"),
        row(3, "2026-11-10T08:00:00+00:00", "nepoznata"),
      ],
    ]);
    const result = await read(TOKEN, DOC, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.continued).toBe(false);
    expect(result.value.next).toBeNull();
    expect(result.value.days).toHaveLength(1);
    expect(result.value.days[0]!.entries.map((e) => e.surface)).toEqual([
      "declaration",
      "process_summary",
      "unknown",
    ]);
  });

  it("reads from a cursor, and a refused or future cursor as the first page", async () => {
    const cursor = { beforeAt: "2026-11-10T08:05:00.000Z", beforeId: id(2) };
    const now = Date.parse("2026-11-11T00:00:00Z");
    const good = reader([[row(3, "2026-11-10T08:00:00+00:00")]]);
    const page = await good.read(TOKEN, DOC, cursor, now);
    expect(page.ok && page.value.continued).toBe(true);
    expect(good.seen[0]).toContain(cursor.beforeAt);

    const future = reader([[]]);
    const later = await future.read(
      TOKEN,
      DOC,
      { ...cursor, beforeAt: "2026-11-12T00:00:00.000Z" },
      now,
    );
    expect(later.ok && later.value.continued).toBe(false);
    expect(future.seen[0]).not.toContain("2026-11-12T00:00:00.000Z");

    const off = reader([[]]);
    const refused = await off.read(
      TOKEN,
      DOC,
      { beforeAt: "2026-11-10T08:01:00.000Z", beforeId: "x" },
      now,
    );
    expect(refused.ok && refused.value.continued).toBe(false);
    expect(off.seen).toHaveLength(1);
  });

  it("answers another's work and no session as the port does", async () => {
    const other = await reader({ code: "ZD403" }).read(TOKEN, DOC, null);
    expect(!other.ok && other.error.code).toBe("MY_ACCESS_LOG_NOT_FOUND");
    const none = await reader([[]]).read(undefined, DOC, null);
    expect(!none.ok && none.error.code).toBe("MY_ACCESS_LOG_UNAUTHENTICATED");
    const broken = await reader([[{ ...row(1, "2026-11-10T13:11:00+00:00") }]]).read(
      TOKEN,
      DOC,
      null,
    );
    expect(!broken.ok && broken.error.code).toBe("MY_ACCESS_LOG_ROW_MALFORMED");
  });
});

// M10.4-P02: the files of server/ that call a listed function are exactly the
// callers the list names, so a new adapter over a content read is not missed.
describe("work read paths in server/", () => {
  const ROOT = new URL("../../../", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) {
        if (name !== "generated" && name !== "node_modules") walk(path);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        files.push(path);
      }
    }
  };
  walk("server");
  const sources = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
  const all = [...WORK_READ_PATHS, ...NOT_A_PERSON_READ];

  it("lists each function once", () => {
    const names = all.map((p) => p.fn);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(all.map((p) => [p.fn, p.callers] as const))(
    "%s has exactly its callers",
    (fn, callers) => {
      const call = new RegExp(`\\b${fn.replace(".", "\\.")}\\(`);
      const found = [...sources]
        .filter(([, text]) => call.test(text))
        .map(([f]) => f)
        .sort();
      expect(found).toEqual([...callers].sort());
    },
  );

  it("names a pgTAP proof that reads audit.access_log and calls the function", () => {
    for (const path of WORK_READ_PATHS) {
      const proof = readFileSync(join(ROOT, path.proof), "utf8");
      expect(proof, path.fn).toMatch(/audit\.access_log/);
      expect(proof, path.fn).toContain(path.fn);
    }
  });
});
