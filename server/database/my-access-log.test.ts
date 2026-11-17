// DAN-859-1 (contract Ductus#1836 c.6943482512): the student reads only her
// own access log. Who asks comes only from the token inside withActor; the
// database answers ZD403 for another person's, an unknown or a malformed work
// alike (pgTAP 115), and the port gives all of them one answer. Negative cases
// first. Every token, id and name below is invented.
// Every assertion of Ductus my-access-log.test.ts and access-log-days.test.ts
// at b36c82b about the first-page read and the row check is kept here. Those
// about the cursor, the Zagreb days, a repeated id and merging pages move with
// that code to DAN-859-2; those about console.error do not apply (nothing is
// logged here, docs/CODE_STYLE.md §8: the answer is a Result with an AppError).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ACCESS_LOG_PAGE,
  type AccessLogCursor,
  createMyAccessLogReader,
  MY_ACCESS_LOG_CURSOR_INVALID,
  MY_ACCESS_LOG_DATABASE_ERROR,
  MY_ACCESS_LOG_ERRORS,
  MY_ACCESS_LOG_NOT_FOUND,
  MY_ACCESS_LOG_ROW_MALFORMED,
  MY_ACCESS_LOG_UNAUTHENTICATED,
} from "./my-access-log.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-zapisa-pristupa-0000000001";
const DOC = "dokument-izmisljeni-1";
const ID = "00000000-0000-4000-8000-0000000000e1";
const ROW = {
  entry_id: ID,
  opened_at: "2026-11-10T13:10:00+00:00",
  surface: "live_view",
  reader_role: "mentor",
  reader_given_name: "Izmišljena",
  reader_family_name: "Mentorica",
};

function reader(answer: Record<string, unknown>[] | { thrown: unknown }) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  let transactions = 0;
  const withActor = (async (token, fn) => {
    transactions += 1;
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        if (!Array.isArray(answer)) throw answer.thrown;
        return { rows: answer as never[], rowCount: answer.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { log: createMyAccessLogReader(withActor), seen, transactions: () => transactions };
}

const fail = (error: unknown) => ({ ok: false, error });
const UNAUTHENTICATED = fail(MY_ACCESS_LOG_UNAUTHENTICATED);
const NOT_FOUND = fail(MY_ACCESS_LOG_NOT_FOUND);
const ROW_MALFORMED = fail(MY_ACCESS_LOG_ROW_MALFORMED);
const DATABASE_ERROR = fail(MY_ACCESS_LOG_DATABASE_ERROR);

const sqlError = (code: unknown) => Object.assign(new Error("tekst greške baze"), { code });

const catalogue = JSON.parse(
  readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
) as { myAccessLog?: Record<string, unknown> };

describe("my access log errors (docs/CODE_STYLE.md §8)", () => {
  it("has a Croatian text for every key, and no other key in its section", () => {
    const section = catalogue.myAccessLog ?? {};
    for (const { messageKey } of MY_ACCESS_LOG_ERRORS) {
      const text = section[messageKey.replace(/^myAccessLog\./, "")];
      expect(typeof text === "string" && text.trim().length > 0, messageKey).toBe(true);
    }
    expect(
      Object.keys(section)
        .map((k) => `myAccessLog.${k}`)
        .sort(),
    ).toEqual(MY_ACCESS_LOG_ERRORS.map((e) => e.messageKey).sort());
  });

  it("lists five errors with distinct UPPER_SNAKE codes", () => {
    expect(MY_ACCESS_LOG_ERRORS).toHaveLength(5);
    for (const { code } of MY_ACCESS_LOG_ERRORS) expect(code).toMatch(/^MY_ACCESS_LOG_[A-Z_]+$/);
    expect(new Set(MY_ACCESS_LOG_ERRORS.map((e) => e.code)).size).toBe(5);
  });
});

describe("my access log: refusals", () => {
  it("answers not_found, and nothing else, when the database refuses the work (ZD403)", async () => {
    const r = reader({ thrown: sqlError("ZD403") });
    expect(await r.log.read(TOKEN, DOC)).toEqual(NOT_FOUND);
  });

  it("answers unauthenticated when the database finds no session (ZD401)", async () => {
    const r = reader({ thrown: sqlError("ZD401") });
    expect(await r.log.read(TOKEN, DOC)).toEqual(UNAUTHENTICATED);
  });

  const tokens: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["42 characters", TOKEN.slice(1)],
    ["44 characters", `${TOKEN}A`],
    ["trailing CRLF", `${TOKEN}\r\n`],
    ["trailing LF", `${TOKEN}\n`],
    ["tab", `${TOKEN.slice(1)}\t`],
    ["NBSP", `${TOKEN.slice(1)}\u00a0`],
    ["DEL", `${TOKEN.slice(1)}\u007f`],
    ["padding", `${TOKEN.slice(1)}=`],
  ];
  it.each(tokens)("refuses a token that is %s before the database", async (_name, token) => {
    const r = reader([ROW]);
    expect(await r.log.read(token, DOC)).toEqual(UNAUTHENTICATED);
    expect(r.transactions()).toBe(0);
  });

  const documents: [string, string][] = [
    ["empty", ""],
    ["257 characters", "d".repeat(257)],
    ["a space at the edge", ` ${DOC}`],
    ["NBSP at the edge", `${DOC}\u00a0`],
    ["a tab", `dokument\t1`],
    ["CR", `dokument\r1`],
    ["LF", `dokument\n1`],
    ["DEL", `dokument\u007f1`],
    ["C1 U+0085", `dokument\u00851`],
  ];
  it.each(documents)(
    "answers not_found for a work id with %s, before the database",
    async (_n, doc) => {
      const r = reader([ROW]);
      expect(await r.log.read(TOKEN, doc)).toEqual(NOT_FOUND);
      expect(r.transactions()).toBe(0);
    },
  );

  const rows: [string, Record<string, unknown>][] = [
    ["an id that is not a lower-case uuid", { entry_id: ID.toUpperCase() }],
    ["a time off the five-minute grid", { opened_at: "2026-11-10T13:11:00Z" }],
    ["a time without a zone", { opened_at: "2026-11-10T13:10:00" }],
    ["30 February", { opened_at: "2026-02-30T13:10:00Z" }],
    ["a microsecond", { opened_at: "2026-11-10T13:10:00.000001Z" }],
    ["half a name", { reader_family_name: null }],
    ["a name over 255 code points", { reader_given_name: "đ".repeat(256) }],
    // Ductus access-log-days.test.ts cases 4, 8, 9a and 9b at b36c82b.
    ["minutes off the grid", { opened_at: new Date("2026-11-10T13:07:00Z") }],
    ["seconds off the grid", { opened_at: new Date("2026-11-10T13:10:30Z") }],
    ["a millisecond off the grid", { opened_at: new Date("2026-11-10T13:10:00.001Z") }],
    ["an empty name", { reader_given_name: "" }],
    ["an id that is no uuid", { entry_id: "abc" }],
    ["a time that is no instant", { opened_at: "yesterday" }],
    ["an invalid date", { opened_at: new Date(Number.NaN) }],
    ["no time", { opened_at: null }],
    ["a date alone", { opened_at: "2026-11-10" }],
    ["a time in another format", { opened_at: "Tue, 10 Nov 2026 13:10:00" }],
    ["999999 microseconds", { opened_at: "2026-11-10T13:09:59.999999Z" }],
    ["999 microseconds", { opened_at: "2026-11-10T13:10:00.000999Z" }],
    ["a microsecond with an offset", { opened_at: "2026-11-10T14:10:00.000001+01:00" }],
    ["nonzero milliseconds as text", { opened_at: "2026-11-10T13:10:00.001Z" }],
  ];
  it.each(rows)("makes the log unavailable for a row with %s", async (_name, change) => {
    const r = reader([{ ...ROW, ...change }]);
    expect(await r.log.read(TOKEN, DOC)).toEqual(ROW_MALFORMED);
  });

  it("reads another person's work exactly as an unknown work, with no error text", async () => {
    const canary = "kanarinac-dnevnik-3f9c";
    const r = reader({
      thrown: Object.assign(new Error(`do not leak ${canary}`), { code: "ZD403" }),
    });
    const foreign = await r.log.read(TOKEN, "rad-tudji-9");
    expect(await r.log.read(TOKEN, "rad-nepostojeci")).toEqual(foreign);
    expect(JSON.stringify(foreign)).not.toContain(canary);
    const odd = await reader({ thrown: sqlError(`bad ${canary}`) }).log.read(TOKEN, DOC);
    expect(odd).toEqual(DATABASE_ERROR);
    expect(await reader({ thrown: sqlError("ZD422") }).log.read(TOKEN, DOC)).toEqual(
      DATABASE_ERROR,
    );
  });

  it("keeps only a closed code of any other error, never its text", async () => {
    expect(await reader({ thrown: sqlError("57014") }).log.read(TOKEN, DOC)).toEqual(
      DATABASE_ERROR,
    );
    for (const thrown of [new Error("bez koda"), sqlError("ne kod"), "string"]) {
      expect(await reader({ thrown }).log.read(TOKEN, DOC)).toEqual(DATABASE_ERROR);
    }
    const getter = Object.defineProperty(new Error("x"), "code", {
      get() {
        throw new Error("getter");
      },
    });
    expect(await reader({ thrown: getter }).log.read(TOKEN, DOC)).toEqual(DATABASE_ERROR);
  });
});

// Ductus access-log-days.test.ts 9c and "calendar validity" at b36c82b, through the port.
const NOT_AN_INSTANT: [string, string][] = [
  ["30 February", "2026-02-30T08:00:00Z"],
  ["29 February of a common year", "2026-02-29T08:00:00Z"],
  ["29 February of a century not divisible by 400", "1900-02-29T08:00:00Z"],
  ["31 April", "2026-04-31T08:00:00Z"],
  ["month 00", "2026-00-10T08:00:00Z"],
  ["month 13", "2026-13-10T08:00:00Z"],
  ["day 00", "2026-11-00T08:00:00Z"],
  ["hour 24", "2026-11-10T24:00:00Z"],
  ["minute 60", "2026-11-10T08:60:00Z"],
  ["second 60", "2026-11-10T08:00:60Z"],
  ["30 February with an offset", "2026-02-30T09:00:00+01:00"],
  ["four fraction digits", "2026-11-10T13:10:00.0001Z"],
  ["five fraction digits", "2026-11-10T13:10:00.00001Z"],
  ["100 microseconds", "2026-11-10T13:10:00.000100Z"],
  ["seven fraction digits", "2026-11-10T13:10:00.0000000Z"],
  ["123001 microseconds", "2026-11-10T13:10:00.123001Z"],
  ["999999 microseconds past", "2026-11-10T13:10:00.999999Z"],
];
describe("my access log: a time given as text", () => {
  it.each(NOT_AN_INSTANT)("refuses %s, beside a valid row (%s)", async (_name, iso) => {
    const bad = { ...ROW, entry_id: "00000000-0000-4000-8000-0000000000e3", opened_at: iso };
    expect(await reader([ROW, bad]).log.read(TOKEN, DOC)).toEqual(ROW_MALFORMED);
  });

  it.each([
    ["29 February of a leap year", "2028-02-29T08:00:00Z", Date.UTC(2028, 1, 29, 8)],
    ["29 February of a year divisible by 400", "2000-02-29T08:00:00Z", Date.UTC(2000, 1, 29, 8)],
    ["31 December", "2026-12-31T23:55:00Z", Date.UTC(2026, 11, 31, 23, 55)],
    ["1 January", "2027-01-01T00:00:00Z", Date.UTC(2027, 0, 1)],
  ])("reads %s exactly (%s)", async (_name, iso, ms) => {
    const read = await reader([{ ...ROW, opened_at: iso }]).log.read(TOKEN, DOC);
    expect(read.ok && read.value.entries[0]?.at).toBe(ms);
  });
});

describe("my access log: the student's own", () => {
  it("names the caller only through the token, in one statement of one transaction", async () => {
    const r = reader([ROW]);
    const doc = `d${"\u00a0".repeat(2)}${"x".repeat(253)}`;
    await r.log.read(TOKEN, doc);
    expect(r.transactions()).toBe(1);
    expect(r.seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT * FROM app.read_my_access_log($1, $2, $3, $4)",
        values: [doc, 50, null, null],
      },
    ]);
  });

  it("returns the rows in the database's order, an unknown role or surface kept as unknown", async () => {
    const older = {
      ...ROW,
      entry_id: "00000000-0000-4000-8000-0000000000e2",
      opened_at: new Date(Date.UTC(2026, 10, 9, 8, 0)),
    };
    const odd = {
      ...older,
      reader_role: "dean",
      surface: "export",
      reader_given_name: null,
      reader_family_name: null,
    };
    expect(await reader([ROW, odd]).log.read(TOKEN, DOC)).toEqual({
      ok: true,
      value: {
        entries: [
          {
            id: ID,
            at: Date.UTC(2026, 10, 10, 13, 10),
            role: "mentor",
            surface: "live_view",
            reader: { givenName: "Izmišljena", familyName: "Mentorica" },
          },
          {
            id: older.entry_id,
            at: Date.UTC(2026, 10, 9, 8, 0),
            role: "unknown",
            surface: "unknown",
            reader: null,
          },
        ],
        next: null,
      },
    });
  });

  it("reads an empty log as ok with no entry, and counts nothing", async () => {
    expect(await reader([]).log.read(TOKEN, DOC)).toEqual({
      ok: true,
      value: {
        entries: [],
        next: null,
      },
    });
    const read = await reader([ROW]).log.read(TOKEN, DOC);
    expect(JSON.stringify(read)).not.toMatch(/"(count|total|duration|visits)"/);
  });

  // Ductus access-log-days.test.ts cases 7, 9a and 9b at b36c82b.
  it.each([
    ["Z", "2026-11-10T13:10:00Z"],
    ["an offset", "2026-11-10T14:10:00+01:00"],
    ["a zero fraction", "2026-11-10T13:10:00.0Z"],
    ["exactly milliseconds", "2026-11-10T13:10:00.000Z"],
    ["six zero digits", "2026-11-10T13:10:00.000000Z"],
  ])("reads a time given as text with %s as the same instant", async (_name, openedAt) => {
    const read = await reader([{ ...ROW, opened_at: openedAt, reader_role: null }]).log.read(
      TOKEN,
      DOC,
    );
    expect(read.ok && read.value.entries[0]).toMatchObject({
      at: Date.UTC(2026, 10, 10, 13, 10),
      role: "unknown",
    });
  });

  it("points to the oldest row when the page is full", async () => {
    const page = Array.from({ length: 50 }, (_, i) => ({
      ...ROW,
      entry_id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
      opened_at: new Date(Date.UTC(2026, 10, 10, 13, 10) - (i % 3) * 300_000),
    }));
    const read = await reader(page).log.read(TOKEN, DOC);
    expect(read.ok && read.value.next).toEqual({
      beforeAt: "2026-11-10T13:00:00.000Z",
      beforeId: "00000000-0000-4000-8000-000000000102",
    });
  });
});

// DAN-859-2a (contract Ductus#1836 c.6946441810): a continuation from a cursor.
// The cursor is the student's input; it never names whose log is read.
const AT = "2026-11-10T13:00:00.000Z";
const at = (beforeAt: string, beforeId = ID): AccessLogCursor => ({ beforeAt, beforeId });
const CURSOR_INVALID = fail(MY_ACCESS_LOG_CURSOR_INVALID);

describe("my access log: a cursor that is not one", () => {
  it.each([
    ...[
      "",
      "jucer",
      "2026-11-10T13:00:00",
      "2026-02-30T13:00:00Z",
      "2026-11-09T24:00:00Z",
      "2026-11-10T13:00:60Z",
      "2026-11-10T13:00:00.000001Z",
      "2026-11-10T13:00:00.001Z",
      "2026-11-10T13:47:00Z",
      "0000-01-01T00:00:00Z",
      "0001-01-01T00:00:00+01:00",
      "9999-12-31T23:55:00-01:00",
      `${AT}\n`,
      `${AT}\r\n`,
      `${AT}\t`,
      `${AT}\u00a0`,
      `${AT}\u007f`,
      ` ${AT}`,
      "2026-11-10T14:00:00+01",
    ].map((beforeAt) => at(beforeAt)),
    ...[
      ID.toUpperCase(),
      ID.replace("e1", "g1"),
      "",
      ID.slice(1),
      `${ID}0`,
      `${ID}\n`,
      `${ID}\u00a0`,
      `${ID}\u007f`,
    ].map((beforeId) => at(AT, beforeId)),
    { beforeAt: 1, beforeId: ID } as unknown as AccessLogCursor,
  ])("refuses %j before the database, with no text of it", async (cursor) => {
    const r = reader([ROW]);
    expect(await r.log.read(TOKEN, DOC, cursor)).toEqual(CURSOR_INVALID);
    expect(r.transactions()).toBe(0);
  });

  it("checks the token and the work before the cursor, and a refusal reads as without one", async () => {
    const bad = at("jucer");
    expect(await reader([ROW]).log.read("kratak", DOC, bad)).toEqual(UNAUTHENTICATED);
    expect(await reader([ROW]).log.read(TOKEN, " ", bad)).toEqual(NOT_FOUND);
    for (const [code, answer] of [
      ["ZD403", NOT_FOUND],
      ["ZD401", UNAUTHENTICATED],
    ] as const) {
      expect(await reader({ thrown: sqlError(code) }).log.read(TOKEN, DOC, at(AT))).toEqual(answer);
    }
  });

  it("leaves out a row not older than the cursor, and never points next at it", async () => {
    const page = Array.from({ length: ACCESS_LOG_PAGE }, (_, i) => ({
      ...ROW,
      entry_id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
      opened_at: new Date(Date.parse(AT) - 300_000 * (i + 1)),
    }));
    const newer = [
      { ...ROW, opened_at: AT },
      { ...ROW, entry_id: page[0]!.entry_id, opened_at: "2026-11-10T13:05:00Z" },
    ];
    const read = await reader([...newer, ...page]).log.read(TOKEN, DOC, at(AT));
    expect(read.ok && read.value.entries.map((e) => e.id)).toEqual(page.map((r) => r.entry_id));
    expect(read.ok && read.value.next?.beforeAt).toBe(
      new Date(Date.parse(AT) - 300_000 * 50).toISOString(),
    );
    const short = await reader([newer[0]!, ...page.slice(1)]).log.read(TOKEN, DOC, at(AT));
    expect(short.ok && short.value.next).toBeNull();
    const malformed = await reader([{ ...ROW, opened_at: AT, entry_id: "abc" }]).log.read(
      TOKEN,
      DOC,
      at(AT),
    );
    expect(malformed).toEqual(ROW_MALFORMED);
  });
});

describe("my access log: a continuation", () => {
  it.each([
    [AT, AT],
    ["2026-11-10T14:00:00+01:00", AT],
    ["2026-11-10T14:00:00+0100", AT],
    ["2026-11-10t13:00:00z", AT],
    ["2026-11-10T13:00:00.000000Z", AT],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
    ["9999-12-31T23:55:00Z", "9999-12-31T23:55:00.000Z"],
    ["2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z"],
  ])("sends %s to the read as %s, the token only to withActor", async (beforeAt, sent) => {
    const unknownId = "00000000-0000-4000-8000-00000000abcd";
    const r = reader([]);
    expect(await r.log.read(TOKEN, DOC, at(beforeAt, unknownId))).toEqual({
      ok: true,
      value: { entries: [], next: null },
    });
    expect(r.seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT * FROM app.read_my_access_log($1, $2, $3, $4)",
        values: [DOC, 50, sent, unknownId],
      },
    ]);
    expect(r.transactions()).toBe(1);
  });

  it("reads a null cursor as the first page", async () => {
    const r = reader([]);
    await r.log.read(TOKEN, DOC, null);
    expect(r.seen[0]?.values).toEqual([DOC, 50, null, null]);
  });

  /** The read as migration 20261107180000 states it: older windows, the whole edge window. */
  function rpc(log: Record<string, unknown>[]) {
    let reads = 0;
    const withActor = (async (_token, fn) =>
      fn({
        async query(_text, values) {
          reads += 1;
          const [, limit, beforeAt] = values as [string, number, string | null];
          const t = (r: Record<string, unknown>) => (r.opened_at as Date).getTime();
          const mine = log.filter((r) => beforeAt === null || t(r) < Date.parse(beforeAt));
          const edge =
            mine
              .map(t)
              .sort((a, b) => b - a)
              .slice(0, limit)
              .at(-1) ?? Infinity;
          const rows = mine
            .filter((r) => t(r) >= edge)
            .sort(
              (a, b) => t(b) - t(a) || ((a.entry_id as string) < (b.entry_id as string) ? 1 : -1),
            );
          return { rows: rows as never[], rowCount: rows.length };
        },
      })) as WithActor;
    return { log: createMyAccessLogReader(withActor), reads: () => reads };
  }
  const row = (n: number, window = n) => ({
    ...ROW,
    entry_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    opened_at: new Date(Date.parse(AT) - window * 300_000),
  });
  async function follow(log: Record<string, unknown>[]) {
    const r = rpc(log);
    const pages: string[][] = [];
    let cursor: AccessLogCursor | null = null;
    do {
      const read = await r.log.read(TOKEN, DOC, cursor);
      if (!read.ok) throw new Error(read.error.code);
      pages.push(read.value.entries.map((e) => e.id));
      cursor = read.value.next;
    } while (cursor !== null && pages.length <= log.length);
    return { pages, reads: r.reads() };
  }

  it("reaches every one of 1001 openings exactly once by following next", async () => {
    const log = Array.from({ length: 1001 }, (_, i) => row(i + 1));
    const { pages, reads } = await follow(log);
    expect(reads).toBe(Math.ceil(1001 / ACCESS_LOG_PAGE));
    expect(pages.flat()).toEqual(log.map((r) => r.entry_id));
  });

  it("takes the whole edge window on the first page and repeats nothing after it", async () => {
    const log = [
      ...Array.from({ length: 49 }, (_, i) => row(i + 1)),
      row(7003, 50),
      row(7001, 50),
      row(7002, 50),
      ...Array.from({ length: 5 }, (_, i) => row(i + 53)),
    ];
    const { pages } = await follow(log);
    expect(pages.map((p) => p.length)).toEqual([52, 5]);
    expect([...pages.flat()].sort()).toEqual(log.map((r) => r.entry_id).sort());
  });
});
