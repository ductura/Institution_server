import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ActorReader } from "../database/index.ts";

import {
  PRINCIPAL_SCOPE_LABEL,
  principalScope,
  SESSION_TAG_LABEL,
  sessionPrincipal,
  sessionPrincipalWithInstitution,
  sessionTag,
} from "./principal.ts";

// F-5, plan #376 rows 1 and 7: the journal scope comes from the session the
// database recognises, never from anything else in the request.

const TOKEN = "A".repeat(43);
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";
const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";

type Actor = {
  userId: string | null;
  institutionId: string | null;
  institutionSlug?: string | null;
};

// A fake of the ActorReader port of server/database: it records which call
// was made under which token and answers with the given actor, in camelCase.
function fakeReader(actor: Actor) {
  const calls: string[] = [];
  const tokens: string[] = [];
  const reader: ActorReader = {
    async currentActor(token) {
      calls.push("currentActor");
      tokens.push(token);
      return { userId: actor.userId, institutionId: actor.institutionId };
    },
    async currentActorWithInstitution(token) {
      calls.push("currentActorWithInstitution");
      tokens.push(token);
      return {
        userId: actor.userId,
        institutionId: actor.institutionId,
        institutionSlug: actor.institutionSlug ?? null,
      };
    },
  };
  return { reader, calls, tokens };
}

function failingReader(error: Error): ActorReader {
  return {
    currentActor: async () => {
      throw error;
    },
    currentActorWithInstitution: async () => {
      throw error;
    },
  };
}

const SIGNED_OUT_ACTOR: Actor = { userId: null, institutionId: null, institutionSlug: null };

describe("sessionPrincipal", () => {
  it("names the journal of the person and institution the database returns", async () => {
    const db = fakeReader({ userId: USER_A, institutionId: INSTITUTION });
    const principal = await sessionPrincipal(TOKEN, db.reader);
    expect(principal).toEqual({ kind: "signed-in", scope: principalScope(USER_A, INSTITUTION) });
    expect(db.tokens).toEqual([TOKEN]);
    expect(db.calls).toEqual(["currentActor"]);
  });

  it.each([
    ["no cookie", undefined],
    ["an empty cookie", ""],
    ["a short cookie", "A".repeat(42)],
    ["a cookie with other characters", `${"A".repeat(42)}=`],
  ])("is signed out without asking the database for %s", async (ignoredName, token) => {
    const db = fakeReader({ userId: USER_A, institutionId: INSTITUTION });
    expect(await sessionPrincipal(token, db.reader)).toEqual({ kind: "signed-out" });
    expect(db.tokens).toEqual([]);
  });

  it.each([
    ["a closed or expired session (current_actor gives nulls)", SIGNED_OUT_ACTOR],
    ["a user without an institution", { userId: USER_A, institutionId: null }],
    ["an institution without a user", { userId: null, institutionId: INSTITUTION }],
    ["an empty user id", { userId: "", institutionId: INSTITUTION }],
  ])("is signed out for %s", async (ignoredName, actor) => {
    expect(await sessionPrincipal(TOKEN, fakeReader(actor).reader)).toEqual({
      kind: "signed-out",
    });
  });

  it("is unverified, not signed out, when the database cannot answer, and logs no token", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failingReader(
      Object.assign(new Error(`connection refused for ${TOKEN}`), { name: "DatabaseError" }),
    );
    expect(await sessionPrincipal(TOKEN, failing)).toEqual({ kind: "unverified" });
    expect(log).toHaveBeenCalledWith("session check failed", "DatabaseError");
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });
});

// M2.12-P02, plan #1689 C1 to C7: the institution comes from the same
// statement as the person, never from the request.
describe("sessionPrincipalWithInstitution", () => {
  it("names the scope and the slug of the session's institution in one call", async () => {
    const db = fakeReader({ userId: USER_A, institutionId: INSTITUTION, institutionSlug: "fak-a" });
    expect(await sessionPrincipalWithInstitution(TOKEN, db.reader)).toEqual({
      kind: "signed-in",
      scope: principalScope(USER_A, INSTITUTION),
      institution: "fak-a",
    });
    expect(db.tokens).toEqual([TOKEN]);
    expect(db.calls).toEqual(["currentActorWithInstitution"]);
  });

  it("keeps the same scope as sessionPrincipal, so no journal moves", async () => {
    const actor = { userId: USER_B, institutionId: INSTITUTION, institutionSlug: "fak-b" };
    const plain = await sessionPrincipal(TOKEN, fakeReader(actor).reader);
    const withSlug = await sessionPrincipalWithInstitution(TOKEN, fakeReader(actor).reader);
    expect(
      plain.kind === "signed-in" && withSlug.kind === "signed-in" && plain.scope === withSlug.scope,
    ).toBe(true);
  });

  it("is signed in without an institution for a missing slug", async () => {
    const db = fakeReader({ userId: USER_A, institutionId: INSTITUTION, institutionSlug: null });
    expect(await sessionPrincipalWithInstitution(TOKEN, db.reader)).toEqual({
      kind: "signed-in",
      scope: principalScope(USER_A, INSTITUTION),
      institution: null,
    });
  });

  it.each([
    ["no cookie", undefined],
    ["a malformed cookie", `${"A".repeat(42)}=`],
  ])("is signed out without asking the database for %s", async (ignoredName, token) => {
    const db = fakeReader({ userId: USER_A, institutionId: INSTITUTION, institutionSlug: "fak-a" });
    expect(await sessionPrincipalWithInstitution(token, db.reader)).toEqual({
      kind: "signed-out",
    });
    expect(db.tokens).toEqual([]);
  });

  it.each([
    ["a closed or expired session", SIGNED_OUT_ACTOR],
    ["a slug without a person", { userId: null, institutionId: null, institutionSlug: "fak-a" }],
    [
      "a user without an institution",
      { userId: USER_A, institutionId: null, institutionSlug: "fak-a" },
    ],
  ])("is signed out, with no slug, for %s", async (ignoredName, actor) => {
    expect(await sessionPrincipalWithInstitution(TOKEN, fakeReader(actor).reader)).toEqual({
      kind: "signed-out",
    });
  });

  it("is unverified when the database cannot answer, and logs only the error name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = failingReader(
      Object.assign(new Error(`function missing for ${TOKEN}`), { name: "DatabaseError" }),
    );
    expect(await sessionPrincipalWithInstitution(TOKEN, failing)).toEqual({ kind: "unverified" });
    expect(log).toHaveBeenCalledWith("session check failed", "DatabaseError");
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });

  it('is unverified, logging "unknown", for a thrown value that is not an Error', async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: ActorReader = {
      currentActor: async () => Promise.reject(TOKEN as unknown as Error),
      currentActorWithInstitution: async () => Promise.reject(TOKEN as unknown as Error),
    };
    expect(await sessionPrincipalWithInstitution(TOKEN, failing)).toEqual({ kind: "unverified" });
    expect(log).toHaveBeenCalledWith("session check failed", "unknown");
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    log.mockRestore();
  });
});

describe("sessionTag", () => {
  it("is a labelled digest of the cookie, never the database's token digest", () => {
    const tag = sessionTag(TOKEN);
    expect(tag).toBe(
      createHash("sha256").update(`${SESSION_TAG_LABEL}\n${TOKEN}`, "utf8").digest("hex"),
    );
    expect(tag).not.toBe(createHash("sha256").update(TOKEN, "utf8").digest("hex"));
    expect(tag).not.toContain(TOKEN);
    expect(sessionTag("B".repeat(43))).not.toBe(tag);
  });

  it.each([undefined, "", "A".repeat(42), `${"A".repeat(42)}=`])("is null for %s", (token) => {
    expect(sessionTag(token)).toBeNull();
  });
});

describe("principalScope", () => {
  it("is the SHA-256 hex of the versioned label, institution and user", () => {
    const expected = createHash("sha256")
      .update(`${PRINCIPAL_SCOPE_LABEL}\n${INSTITUTION}\n${USER_A}`, "utf8")
      .digest("hex");
    expect(principalScope(USER_A, INSTITUTION)).toBe(expected);
    expect(principalScope(USER_A, INSTITUTION)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("differs per user, per institution and from the local demo scope", () => {
    // The web journal scope (Ductus src/lib/journal/local-scope.ts at d52a92c3)
    // stays in the web app; its digest is copied here and recomputed.
    const LOCAL_DEMO_SCOPE_HASH =
      "7b240ae113072b46d91df37b08b29482f6761431bd88caed744fc82151689d1d";
    expect(createHash("sha256").update("ductus-local-demo-journal-v1").digest("hex")).toBe(
      LOCAL_DEMO_SCOPE_HASH,
    );
    const scopes = new Set([
      principalScope(USER_A, INSTITUTION),
      principalScope(USER_B, INSTITUTION),
      principalScope(USER_A, "00000000-0000-4000-8000-0000000000f2"),
      LOCAL_DEMO_SCOPE_HASH,
    ]);
    expect(scopes.size).toBe(4);
  });
});
