// SRV-1405: the port of app.institution_config over a fake withActor. The
// rules pass the schema before the database, ZD401, ZD403, ZD409 and ZD422
// are outcomes, and an assignment reads its own version or, without one, the
// faculty file. The database side of acceptance (1) and (3) is pgTAP 188.
// Every id, token and rule below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createInstitutionConfigStore, type FacultyRules } from "./index.ts";

const TOKEN = "izmisljeni-token-administratora-0000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const ADMIN = "00000000-0000-4000-8000-000000000103";
const AT = new Date("2026-11-21T09:15:00.000Z");
const V1: FacultyRules = {
  citationStyle: "fpzg",
  workLanguages: ["hr", "en"],
  defaultWorkLanguage: "hr",
};
const V2: FacultyRules = {
  citationStyle: "fpzg",
  workLanguages: ["hr"],
  defaultWorkLanguage: "hr",
};

function store(answer: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { store: createInstitutionConfigStore(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("publish", () => {
  it("sends checked rules and the expected version, and returns the next version", async () => {
    const { store: s, seen } = store([{ version: 3 }]);
    expect(await s.publish(TOKEN, 2, V1)).toEqual({ status: "ok", version: 3 });
    expect(seen).toEqual([
      {
        text: expect.stringContaining("app.publish_institution_config($1::integer, $2::jsonb)"),
        values: [2, JSON.stringify(V1)],
      },
    ]);
  });

  it.each([
    ["rules outside the schema", 0, { ...V1, aiPolicy: "encouraged" }],
    ["rules that are not an object", 0, "fpzg"],
    ["a negative expected version", -1, V1],
    ["a fractional expected version", 0.5, V1],
  ])("refuses %s before the database", async (_name, expected, rules) => {
    const { store: s, seen } = store([{ version: 1 }]);
    expect(await s.publish(TOKEN, expected, rules)).toEqual({ status: "invalid_input" });
    expect(seen).toEqual([]);
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "forbidden"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid_input"],
  ])("maps %s to %s", async (code, status) => {
    expect(await store(sqlError(code)).store.publish(TOKEN, 0, V1)).toEqual({ status });
  });

  it("throws on any other database error and on a version that does not follow", async () => {
    await expect(store(sqlError("XX000")).store.publish(TOKEN, 0, V1)).rejects.toThrow(
      "izmisljena greska",
    );
    await expect(store([{ version: 5 }]).store.publish(TOKEN, 0, V1)).rejects.toThrow(
      "invalid published institution config version",
    );
  });
});

describe("versions", () => {
  it("returns the chain of the own institution", async () => {
    const rows = [
      { authenticated: true, version: 1, rules: V1, createdBy: ADMIN, createdAt: AT },
      { authenticated: true, version: 2, rules: V2, createdBy: ADMIN, createdAt: AT },
    ];
    expect(await store(rows).store.versions(TOKEN)).toEqual({
      status: "ok",
      versions: [
        { version: 1, rules: V1, createdBy: ADMIN, createdAt: AT.toISOString() },
        { version: 2, rules: V2, createdBy: ADMIN, createdAt: AT.toISOString() },
      ],
    });
  });

  it("tells an empty list from a caller without a session", async () => {
    const none = { version: null, rules: null, createdBy: null, createdAt: null };
    expect(await store([{ authenticated: true, ...none }]).store.versions(TOKEN)).toEqual({
      status: "ok",
      versions: [],
    });
    expect(await store([{ authenticated: false, ...none }]).store.versions(TOKEN)).toEqual({
      status: "unauthorized",
    });
  });

  it("refuses a chain with a gap or a stored row outside the schema", async () => {
    const gap = [{ authenticated: true, version: 2, rules: V1, createdBy: ADMIN, createdAt: AT }];
    await expect(store(gap).store.versions(TOKEN)).rejects.toThrow(
      "invalid institution config chain",
    );
    const bad = [
      { authenticated: true, version: 1, rules: { x: 1 }, createdBy: ADMIN, createdAt: AT },
    ];
    await expect(store(bad).store.versions(TOKEN)).rejects.toThrow(
      "invalid stored institution config",
    );
  });
});

describe("assignmentRules (acceptance 3, port side)", () => {
  it("returns the version the assignment was created under, not the file", async () => {
    const { store: s, seen } = store([{ version: 1, rules: V1 }]);
    expect(await s.assignmentRules(TOKEN, A, V2)).toEqual({ status: "ok", version: 1, rules: V1 });
    expect(seen[0]?.values).toEqual([A]);
  });

  it("falls back to the faculty file only when the assignment has no version", async () => {
    expect(await store([]).store.assignmentRules(TOKEN, A, V2)).toEqual({
      status: "ok",
      version: null,
      rules: V2,
    });
    expect(await store([]).store.assignmentRules(TOKEN, A, null)).toEqual({
      status: "ok",
      version: null,
      rules: null,
    });
  });

  it("maps refusals and checks the id first", async () => {
    expect(await store(sqlError("ZD401")).store.assignmentRules(TOKEN, A, null)).toEqual({
      status: "unauthorized",
    });
    expect(await store(sqlError("ZD403")).store.assignmentRules(TOKEN, A, null)).toEqual({
      status: "not_found",
    });
    const { store: s, seen } = store([]);
    expect(await s.assignmentRules(TOKEN, "nije-uuid", null)).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });
});
