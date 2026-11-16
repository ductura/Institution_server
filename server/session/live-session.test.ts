// DAN-805, plan of attack ductura/server#98 parts B and C over a fake of the
// ActorReader port; the same outcomes over real PostgreSQL are in
// tests/db/evidence-session.integration.test.ts. Every value is invented.
import { describe, expect, it } from "vitest";

import type { ActorReader, CurrentActor } from "../database/index.ts";

import { checkSession } from "./live-session.ts";

const TOKEN = "k".repeat(43);
const USER = "00000000-0000-4000-8000-000000000001";
const INSTITUTION = "00000000-0000-4000-8000-000000000002";

function reader(answer: () => Promise<CurrentActor>): ActorReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async currentActor(token) {
      calls.push(token);
      return answer();
    },
    async currentActorWithInstitution() {
      throw new Error("not used");
    },
  };
}

const live = { live: true };

describe("checkSession", () => {
  it("B1: an open session passes, verified, with only the token", async () => {
    const actors = reader(async () => ({ userId: USER, institutionId: INSTITUTION }));
    expect(await checkSession(TOKEN, actors, live)).toEqual({
      ok: true,
      token: TOKEN,
      verified: true,
    });
    expect(actors.calls).toEqual([TOKEN]);
  });

  it("no token or a malformed one is unauthenticated without asking the database", async () => {
    const actors = reader(async () => ({ userId: USER, institutionId: INSTITUTION }));
    for (const token of [undefined, "", "k".repeat(42), "k".repeat(44), `${"k".repeat(42)}+`]) {
      expect(await checkSession(token, actors, live)).toEqual({
        ok: false,
        refusal: "unauthenticated",
      });
      expect(await checkSession(token, actors, { live: false })).toEqual({
        ok: false,
        refusal: "unauthenticated",
      });
    }
    expect(actors.calls).toEqual([]);
  });

  it("B2, B3, B4, B8: no live session, or a person without an institution, is unauthenticated", async () => {
    for (const actor of [
      { userId: null, institutionId: null },
      { userId: USER, institutionId: null },
      { userId: null, institutionId: INSTITUTION },
      { userId: "", institutionId: INSTITUTION },
    ]) {
      expect(
        await checkSession(
          TOKEN,
          reader(async () => actor),
          live,
        ),
      ).toEqual({
        ok: false,
        refusal: "unauthenticated",
      });
    }
  });

  it("B7, C4: a database that cannot answer is context, never unauthenticated", async () => {
    const failing = reader(async () => {
      throw new Error(`connection refused for ${TOKEN}`);
    });
    expect(await checkSession(TOKEN, failing, live)).toEqual({ ok: false, refusal: "context" });
  });

  it("C3: without live only the form is checked and the database is not asked", async () => {
    const actors = reader(async () => ({ userId: null, institutionId: null }));
    expect(await checkSession(TOKEN, actors, { live: false })).toEqual({
      ok: true,
      token: TOKEN,
      verified: false,
    });
    expect(actors.calls).toEqual([]);
  });
});
