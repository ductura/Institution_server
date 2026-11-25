// SRV-V17-TEMPLATE-ASSIGN: the port of the work template of an assignment over a fake withActor.
// The id is checked before the database, the switch is confirmed inside the transaction, and
// ZD401, ZD403, ZD409 and ZD422 are outcomes. Every id is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createAssignmentTemplate } from "./index.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const FROZEN = {
  version: 2,
  titlePage: ["title", "author"],
  sections: [{ title: "Uvod", hint: "" }],
  citationStyle: "fpzg",
};

function port(answer: unknown) {
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
  return { port: createAssignmentTemplate(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("set", () => {
  it("switches on through the RPC and answers the pinned version", async () => {
    const { port: p, seen } = port([{ version: 2 }]);
    expect(await p.set(TOKEN, A, true)).toEqual({ status: "saved", version: 2 });
    expect(seen[0]?.text).toContain("app.set_assignment_template(");
    expect(seen[0]?.values).toEqual([A, true]);
  });

  it("switches off to a null version", async () => {
    const { port: p } = port([{ version: 0 }]);
    expect(await p.set(TOKEN, A, false)).toEqual({ status: "saved", version: null });
  });

  it("rolls back an answer that does not fit the switch", async () => {
    for (const [answer, use] of [
      [[{ version: 0 }], true],
      [[{ version: 3 }], false],
      [[{ version: "2" }], true],
      [[{ version: -1 }], false],
      [[], true],
      [[{ version: 1 }, { version: 1 }], true],
    ] as const) {
      await expect(port(answer).port.set(TOKEN, A, use)).rejects.toThrow(
        "unconfirmed assignment template",
      );
    }
  });

  it("answers a malformed id as not found, before the database", async () => {
    const { port: p, seen } = port([{ version: 1 }]);
    expect(await p.set(TOKEN, "nije-uuid", true)).toEqual({ status: "not_found" });
    expect(await p.set(TOKEN, A.toUpperCase(), true)).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "not_found"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid_input"],
  ])("maps %s to %s", async (code, status) => {
    expect(await port(sqlError(code)).port.set(TOKEN, A, true)).toEqual({ status });
  });

  it("throws anything else", async () => {
    await expect(port(sqlError("XX000")).port.set(TOKEN, A, true)).rejects.toThrow();
  });
});

describe("read", () => {
  it("reads the frozen version", async () => {
    const { port: p, seen } = port([FROZEN]);
    expect(await p.read(TOKEN, A)).toEqual({ status: "found", template: FROZEN });
    expect(seen[0]?.text).toContain("app.read_assignment_template(");
    expect(seen[0]?.values).toEqual([A]);
  });

  it("has no template while there is no pin", async () => {
    expect(await port([]).port.read(TOKEN, A)).toEqual({ status: "no_template" });
  });

  it("throws on more than one row", async () => {
    await expect(port([FROZEN, FROZEN]).port.read(TOKEN, A)).rejects.toThrow();
  });

  it("answers a malformed id as not found, before the database", async () => {
    const { port: p, seen } = port([FROZEN]);
    expect(await p.read(TOKEN, "x")).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
  });

  it("maps a stranger to not found", async () => {
    expect(await port(sqlError("ZD403")).port.read(TOKEN, A)).toEqual({ status: "not_found" });
  });
});
