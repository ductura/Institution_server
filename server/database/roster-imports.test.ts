// The roster import port (SRV-ADMIN-2) over a fake withActor: the statement
// and parameters, every refusal by SQLSTATE and an answer of the wrong form
// as unavailable. The port never throws. All values are invented.
import { describe, expect, it } from "vitest";

import { createRosterImports } from "./roster-imports.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-admina-0000000000000000001";
const COURSE = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const IMPORT = "5d1c2b3a-4f5e-4a6b-9c7d-8e9f0a1b2c31";
const ROWS = [
  { identifier: "ana.izmisljena@fakultet.invalid", givenName: "Ana", familyName: "Izmišljena" },
  { identifier: "nepoznata@fakultet.invalid", givenName: "Nepoznata", familyName: "Osoba" },
];
// The database answers snake_case keys; built from pairs (naming-convention).
const snake = (pairs: [string, unknown][]): Record<string, unknown> => Object.fromEntries(pairs);
const PREVIEW = snake([
  ["import_id", IMPORT.toUpperCase()],
  ["expires_at", "2026-11-23T10:30:00.000Z"],
  ["statuses", ["new", "unknown_account"]],
]);
const CONFIRMED = snake([
  ["enrolled", 1],
  ["already_enrolled", 0],
  ["skipped", 0],
  ["already_confirmed", false],
]);

const seen: { text: string; values: readonly unknown[] }[] = [];
const answering =
  (answer: unknown): WithActor =>
  async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ text, values });
        return { rows: [{ answer }] as never[], rowCount: 1 };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

describe("createRosterImports.preview", () => {
  it("calls preview_roster_import(course, source, rows as JSON); the id in lower case", async () => {
    seen.length = 0;
    const port = createRosterImports(answering(PREVIEW));
    expect(await port.preview(TOKEN, COURSE, "merlin", ROWS)).toEqual({
      status: "previewed",
      importId: IMPORT,
      expiresAt: "2026-11-23T10:30:00.000Z",
      statuses: ["new", "unknown_account"],
    });
    expect(seen).toEqual([
      {
        text: expect.stringContaining("institution.preview_roster_import("),
        values: [COURSE, "merlin", JSON.stringify(ROWS)],
      },
    ]);
  });

  it("sends only the three cells of a row", async () => {
    seen.length = 0;
    const extra = [{ ...ROWS[0]!, line: 2, problem: null }];
    await createRosterImports(answering({ ...PREVIEW, statuses: ["new"] })).preview(
      TOKEN,
      COURSE,
      "isvu",
      extra,
    );
    expect(JSON.parse(String(seen[0]?.values[2]))).toEqual([ROWS[0]]);
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD404", { status: "not_found" }],
    ["ZD422", { status: "invalid" }],
    ["ZD410", { status: "unavailable", reason: "database_error" }],
    ["08006", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, outcome) => {
    expect(await createRosterImports(failing(code)).preview(TOKEN, COURSE, "merlin", ROWS)).toEqual(
      outcome,
    );
  });

  it.each([
    ["a status per row too few", { ...PREVIEW, statuses: ["new"] }],
    ["an unknown status", { ...PREVIEW, statuses: ["new", "maybe"] }],
    ["a key too many", { ...PREVIEW, extra: 1 }],
    ["an id that is no UUID", { ...PREVIEW, ...snake([["import_id", "x"]]) }],
    ["an expiry in another form", { ...PREVIEW, ...snake([["expires_at", "2026-11-23"]]) }],
    ["no object", null],
  ])("%s is unavailable", async (_, answer) => {
    expect(
      await createRosterImports(answering(answer)).preview(TOKEN, COURSE, "merlin", ROWS),
    ).toEqual({ status: "unavailable", reason: "roster_preview_malformed" });
  });
});

describe("createRosterImports.confirm", () => {
  it("calls confirm_roster_import(import) and answers camelCase", async () => {
    seen.length = 0;
    const port = createRosterImports(
      answering({ ...CONFIRMED, ...snake([["already_confirmed", true]]) }),
    );
    expect(await port.confirm(TOKEN, IMPORT)).toEqual({
      status: "confirmed",
      enrolled: 1,
      alreadyEnrolled: 0,
      skipped: 0,
      alreadyConfirmed: true,
    });
    expect(seen).toEqual([
      { text: expect.stringContaining("institution.confirm_roster_import("), values: [IMPORT] },
    ]);
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["ZD404", { status: "not_found" }],
    ["ZD410", { status: "expired" }],
    ["ZD422", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, outcome) => {
    expect(await createRosterImports(failing(code)).confirm(TOKEN, IMPORT)).toEqual(outcome);
  });

  it.each([
    ["a negative count", { ...CONFIRMED, enrolled: -1 }],
    ["a count that is no integer", { ...CONFIRMED, skipped: 0.5 }],
    ["a flag that is no boolean", { ...CONFIRMED, ...snake([["already_confirmed", "false"]]) }],
    [
      "a key missing",
      snake([
        ["enrolled", 1],
        ["already_enrolled", 0],
        ["skipped", 0],
      ]),
    ],
  ])("%s is unavailable", async (_, answer) => {
    expect(await createRosterImports(answering(answer)).confirm(TOKEN, IMPORT)).toEqual({
      status: "unavailable",
      reason: "roster_confirm_malformed",
    });
  });
});
