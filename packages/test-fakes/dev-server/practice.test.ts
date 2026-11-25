// SRV-V19-DNEVNIK-UGOVOR on the dev fake server: only the mentor signs, a
// signoff date outside the period is refused, and a state reset (as
// /__lazni/ponovno does it, by Object.assign) takes the records with it.
import { describe, expect, it } from "vitest";

import { createState } from "./index.ts";
import { FAKE_PLACEMENT_ID } from "./practice-routes.ts";
import { send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const PLACEMENT = `/api/v1/practice/placements/${FAKE_PLACEMENT_ID}`;
const ENTRY = { date: "2026-03-09", hours: 4, text: "Izmisljen opis rada." };

describe("practice journal", () => {
  it("signs only inside the period, only as mentor, and forgets on reset", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const add = await send(state, `${PLACEMENT}/entries`, {
      method: "POST",
      headers: student,
      body: ENTRY,
    });
    expect(add.status).toBe(201);
    const sign = (headers: typeof teacher, throughDate: string) =>
      send(state, `${PLACEMENT}/signoffs`, { method: "POST", headers, body: { throughDate } });
    expect((await sign(teacher, "2030-01-01")).status).toBe(422);
    expect((await sign(teacher, "2026-02-01")).status).toBe(422);
    expect((await sign(student, "2026-03-10")).status).toBe(404);
    expect((await sign(teacher, "2026-03-10")).status).toBe(201);
    const list = await send(state, "/api/v1/practice/placements", { headers: teacher });
    expect(list.json).toMatchObject({
      placements: [{ entryCount: 1, signedThrough: "2026-03-10" }],
    });
    Object.assign(state, createState());
    const again = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const after = await send(state, "/api/v1/practice/placements", { headers: again });
    expect(after.json).toMatchObject({ placements: [{ entryCount: 0, signedThrough: null }] });
  });
});
