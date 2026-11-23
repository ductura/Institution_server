import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { FAKE_AAI_IDENTIFIERS } from "./roster-import-routes.ts";
import { contractProblems, send, signIn } from "./testing.ts";

// SRV-ADMIN-2 on the dev fake server: the administrator previews a list of a
// course's students, then confirms it once. All values are invented.
const CSV = [
  "identifikator;ime;prezime",
  `${FAKE_AAI_IDENTIFIERS["student-2"]};Marko;Ljubić`,
  `${FAKE_AAI_IDENTIFIERS.student};Lucija;Đaković`,
  `${FAKE_AAI_IDENTIFIERS.nastavnik};Petar;Kranjčec`,
  "nepoznata@demo.ductus.test;Netko;Nepoznat",
  `${FAKE_AAI_IDENTIFIERS["bez-uloge"]};Ivana;Neimenić`,
  "bez-domene;A;B",
].join("\r\n");

describe("dev fake server: roster import", () => {
  it("previews without enrolling, confirms once, and a teacher may do neither", async () => {
    const state = createState();
    const preview = `/api/v1/institution/admin/courses/${IDS.course}/roster-imports`;
    const admin = await signIn(state, "administrator");
    const before = [...state.courses.find((c) => c.id === IDS.course)!.studentIds];
    const made = await send(state, preview, { body: { source: "isvu", csv: CSV }, headers: admin });
    expect(contractProblems("institution.roster-imports.post", made)).toEqual([]);
    const answer = made.json as {
      importId: string;
      counts: unknown;
      rows: { status: string; reason: string | null }[];
    };
    expect(answer.rows.map((row) => row.reason ?? row.status)).toEqual([
      "new",
      "already_enrolled",
      "course_teacher",
      "unknown_account",
      "name_mismatch",
      "invalid_identifier",
    ]);
    expect(answer.counts).toEqual({ new: 1, alreadyEnrolled: 1, unsuitable: 4 });
    expect(state.courses.find((c) => c.id === IDS.course)!.studentIds).toEqual(before);

    const confirm = `/api/v1/institution/admin/roster-imports/${answer.importId}/confirm`;
    const teacher = await signIn(state, "nastavnik");
    expect((await send(state, confirm, { body: {}, headers: teacher })).status).toBe(403);
    expect(
      (await send(state, preview, { body: { source: "isvu", csv: CSV }, headers: teacher })).status,
    ).toBe(403);
    const first = await send(state, confirm, { body: {}, headers: admin });
    expect(contractProblems("institution.roster-import-confirm.post", first)).toEqual([]);
    expect(first.json).toEqual({
      enrolled: 1,
      alreadyEnrolled: 0,
      skipped: 0,
      alreadyConfirmed: false,
    });
    const again = await send(state, confirm, { body: {}, headers: admin });
    expect(again.json).toEqual({
      enrolled: 1,
      alreadyEnrolled: 0,
      skipped: 0,
      alreadyConfirmed: true,
    });
    expect(state.courses.find((c) => c.id === IDS.course)!.studentIds).toEqual([
      ...before,
      IDS.student2,
    ]);
  });

  it("refuses a file without the columns and an unknown course", async () => {
    const state = createState();
    const admin = await signIn(state, "administrator");
    const preview = `/api/v1/institution/admin/courses/${IDS.course}/roster-imports`;
    const columns = await send(state, preview, {
      body: { source: "merlin", csv: "ime;prezime\nA;B\n" },
      headers: admin,
    });
    expect([columns.status, (columns.json as { code: string }).code]).toEqual([
      422,
      "roster_columns_missing",
    ]);
    const unknown = `/api/v1/institution/admin/courses/00000000-0000-4000-8000-00000000dead/roster-imports`;
    expect(
      (await send(state, unknown, { body: { source: "merlin", csv: CSV }, headers: admin })).status,
    ).toBe(404);
  });
});
