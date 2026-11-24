// SRV-ADMIN-3B: the fake's 409 of a second open export request carries the
// reason and its catalogue key like the real server; the 409 of an approval
// carries neither. All values are invented.
import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { send, signIn } from "./testing.ts";

const URL_OF = "/api/v1/institution/student-data-exports";
const REQUEST = {
  studentId: IDS.student,
  identityCheckedBy: "identity_card",
  note: "IZMISLJENA-PROVJERA-2026-01",
};

describe("dev fake server: second open data export request", () => {
  it("answers 409 with the reason and its catalogue key, as the real server", async () => {
    const state = createState();
    const headers = await signIn(state, "bez-uloge");
    const first = await send(state, URL_OF, { body: REQUEST, headers });
    expect(first.status).toBe(201);
    const second = await send(state, URL_OF, { body: REQUEST, headers });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({
      error: "conflict",
      code: "conflict",
      messageKey: "errors.conflict",
      status: 409,
      reason: "export_already_open",
      reasonKey: "adminSettings.exportAlreadyOpen",
    });
  });

  it("an approval's 409 carries no reason", async () => {
    const state = createState();
    const clerk = await signIn(state, "bez-uloge");
    const created = await send(state, URL_OF, { body: REQUEST, headers: clerk });
    const { exportId } = created.json as { exportId: string };
    const admin = await signIn(state, "administrator");
    const approve = `${URL_OF}/${exportId}/approve`;
    expect(
      (
        await send(state, approve, {
          body: { reference: "IZMISLJENI-POSAO-2026-01" },
          headers: admin,
        })
      ).status,
    ).toBe(200);
    const again = await send(state, approve, {
      body: { reference: "IZMISLJENI-POSAO-2026-01" },
      headers: admin,
    });
    expect(again.status).toBe(409);
    expect(again.json).not.toHaveProperty("reason");
  });
});
