import { describe, expect, it } from "vitest";

import {
  createActorReader,
  CURRENT_ACTOR_SQL,
  CURRENT_ACTOR_WITH_INSTITUTION_SQL,
} from "./current-actor.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

// The row of app.current_actor() becomes camelCase here and nowhere else
// (docs/CODE_STYLE.md 9; ductura/server#20, review comment 4575546772).

const TOKEN = "A".repeat(43);
const USER_A = "00000000-0000-4000-8000-00000000000a";
const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";

function fakeWithActor(row: Record<string, unknown> | undefined) {
  const queries: string[] = [];
  const values: (readonly unknown[] | undefined)[] = [];
  const tokens: (string | null | undefined)[] = [];
  const withActor: WithActor = async (token, fn) => {
    tokens.push(token);
    const tx: ActorTransaction = {
      async query(text, params) {
        queries.push(text);
        values.push(params);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as never;
      },
    };
    return fn(tx);
  };
  return { withActor, queries, values, tokens };
}

describe("createActorReader", () => {
  it("states the statements the session area has always run", () => {
    expect(CURRENT_ACTOR_SQL).toBe("SELECT user_id, institution_id FROM app.current_actor()");
    expect(CURRENT_ACTOR_WITH_INSTITUTION_SQL).toBe(
      "SELECT user_id, institution_id, app.current_institution_slug() AS institution_slug FROM app.current_actor()",
    );
  });

  it("maps user_id and institution_id to camelCase in one statement under the token", async () => {
    const db = fakeWithActor({ user_id: USER_A, institution_id: INSTITUTION });
    expect(await createActorReader(db.withActor).currentActor(TOKEN)).toEqual({
      userId: USER_A,
      institutionId: INSTITUTION,
    });
    expect(db.tokens).toEqual([TOKEN]);
    expect(db.queries).toEqual([CURRENT_ACTOR_SQL]);
    // The token is presented to withActor, never a parameter of the statement.
    expect(db.values).toEqual([undefined]);
  });

  it("maps the slug to institutionSlug from the same statement", async () => {
    const db = fakeWithActor({
      user_id: USER_A,
      institution_id: INSTITUTION,
      institution_slug: "fak-a",
    });
    expect(await createActorReader(db.withActor).currentActorWithInstitution(TOKEN)).toEqual({
      userId: USER_A,
      institutionId: INSTITUTION,
      institutionSlug: "fak-a",
    });
    expect(db.tokens).toEqual([TOKEN]);
    expect(db.queries).toEqual([CURRENT_ACTOR_WITH_INSTITUTION_SQL]);
  });

  it("returns no snake_case key", async () => {
    const db = fakeWithActor({
      user_id: USER_A,
      institution_id: INSTITUTION,
      institution_slug: "fak-a",
    });
    const reader = createActorReader(db.withActor);
    for (const actor of [
      await reader.currentActor(TOKEN),
      await reader.currentActorWithInstitution(TOKEN),
    ]) {
      expect(Object.keys(actor).every((key) => !key.includes("_"))).toBe(true);
    }
  });

  it.each([
    ["a closed or expired session (nulls)", { user_id: null, institution_id: null }],
    ["no row at all", undefined],
    ["values that are not text", { user_id: 7, institution_id: {} }],
  ])("gives nulls for %s", async (ignoredName, row) => {
    const reader = createActorReader(fakeWithActor(row).withActor);
    expect(await reader.currentActor(TOKEN)).toEqual({ userId: null, institutionId: null });
    expect(await reader.currentActorWithInstitution(TOKEN)).toEqual({
      userId: null,
      institutionId: null,
      institutionSlug: null,
    });
  });

  it.each([
    ["a missing slug", null],
    ["no slug column", undefined],
    ["a slug that is not text", 7],
  ])("gives a null slug for %s", async (ignoredName, slug) => {
    const db = fakeWithActor({
      user_id: USER_A,
      institution_id: INSTITUTION,
      institution_slug: slug,
    });
    expect(await createActorReader(db.withActor).currentActorWithInstitution(TOKEN)).toEqual({
      userId: USER_A,
      institutionId: INSTITUTION,
      institutionSlug: null,
    });
  });

  it("lets an error of withActor reach the caller", async () => {
    const failing: WithActor = async () => {
      throw Object.assign(new Error("connection refused"), { name: "DatabaseError" });
    };
    const reader = createActorReader(failing);
    await expect(reader.currentActor(TOKEN)).rejects.toMatchObject({ name: "DatabaseError" });
    await expect(reader.currentActorWithInstitution(TOKEN)).rejects.toMatchObject({
      name: "DatabaseError",
    });
  });
});
