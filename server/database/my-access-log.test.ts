// DAN-859-1 (contract Ductus#1836 c.6943482512): the student reads only her
// own access log. Who asks comes only from the token inside withActor; the
// database answers ZD403 for another person's, an unknown or a malformed work
// alike (pgTAP 115), and the port gives all of them one answer. Negative cases
// first. Every token, id and name below is invented.
// Every assertion of Ductus my-access-log.test.ts and access-log-days.test.ts
// at b36c82b about the first-page read and the row check is kept here. Those
// about the cursor, the Zagreb days, a repeated id and merging pages move with
// that code to DAN-859-2; those about console.error do not apply (nothing is
// logged here, the reason is returned instead).
import { describe, expect, it } from "vitest";

import { createMyAccessLogReader } from "./my-access-log.ts";
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

const sqlError = (code: unknown) => Object.assign(new Error("tekst greške baze"), { code });

describe("my access log: refusals", () => {
  it("answers not_found, and nothing else, when the database refuses the work (ZD403)", async () => {
    const r = reader({ thrown: sqlError("ZD403") });
    expect(await r.log.read(TOKEN, DOC)).toEqual({ status: "not_found" });
  });

  it("answers unauthenticated when the database finds no session (ZD401)", async () => {
    const r = reader({ thrown: sqlError("ZD401") });
    expect(await r.log.read(TOKEN, DOC)).toEqual({ status: "unauthenticated" });
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
    expect(await r.log.read(token, DOC)).toEqual({ status: "unauthenticated" });
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
      expect(await r.log.read(TOKEN, doc)).toEqual({ status: "not_found" });
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
    expect(await r.log.read(TOKEN, DOC)).toEqual({
      status: "unavailable",
      reason: "row_malformed",
    });
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
    expect(odd).toEqual({ status: "unavailable", reason: "unknown" });
    expect(await reader({ thrown: sqlError("ZD422") }).log.read(TOKEN, DOC)).toEqual({
      status: "unavailable",
      reason: "ZD422",
    });
  });

  it("keeps only a closed code of any other error, never its text", async () => {
    expect(await reader({ thrown: sqlError("57014") }).log.read(TOKEN, DOC)).toEqual({
      status: "unavailable",
      reason: "57014",
    });
    for (const thrown of [new Error("bez koda"), sqlError("ne kod"), "string"]) {
      expect(await reader({ thrown }).log.read(TOKEN, DOC)).toEqual({
        status: "unavailable",
        reason: "unknown",
      });
    }
    const getter = Object.defineProperty(new Error("x"), "code", {
      get() {
        throw new Error("getter");
      },
    });
    expect(await reader({ thrown: getter }).log.read(TOKEN, DOC)).toEqual({
      status: "unavailable",
      reason: "unknown",
    });
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
      status: "ok",
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
    });
  });

  it("reads an empty log as ok with no entry, and counts nothing", async () => {
    expect(await reader([]).log.read(TOKEN, DOC)).toEqual({
      status: "ok",
      entries: [],
      next: null,
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
    expect(read.status === "ok" && read.entries[0]).toMatchObject({
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
    expect(read.status === "ok" && read.next).toEqual({
      beforeAt: "2026-11-10T13:00:00.000Z",
      beforeId: "00000000-0000-4000-8000-000000000102",
    });
  });
});
