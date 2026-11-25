// SRV-V21-KOD-TESTOVI-RUTA: the port of the code tests of an assignment over a fake withActor.
// Both calls go through the RPCs with the token's transaction; the database's errors pass through
// untouched for the HTTP edge to map. Every id is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createAssignmentCodeTests } from "./index.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const TESTS = [{ id: "zbroj", title: "Izmišljeni zbroj", input: [1, 2], expected: 3 }];

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
  return { port: createAssignmentCodeTests(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("read", () => {
  it("reads the latest revision through the RPC", async () => {
    const { port: p, seen } = port([{ revisionNo: 3, language: "javascript", tests: TESTS }]);
    expect(await p.read(TOKEN, A)).toEqual({ revisionNo: 3, language: "javascript", tests: TESTS });
    expect(seen[0]?.text).toContain("app.get_assignment_code_tests(");
    expect(seen[0]?.values).toEqual([A]);
  });

  it("is revision 0, javascript and no tests while none is set", async () => {
    expect(await port([]).port.read(TOKEN, A)).toEqual({
      revisionNo: 0,
      language: "javascript",
      tests: [],
    });
  });

  it("refuses more than one row", async () => {
    const row = { revisionNo: 1, language: "javascript", tests: [] };
    await expect(port([row, row]).port.read(TOKEN, A)).rejects.toThrow("invalid code tests read");
  });
});

describe("publish", () => {
  it("adds a revision through the RPC with the tests as JSON text", async () => {
    const { port: p, seen } = port([{ revisionNo: 1, language: "javascript", tests: TESTS }]);
    expect(await p.publish(TOKEN, A, "javascript", TESTS)).toEqual({
      revisionNo: 1,
      language: "javascript",
      tests: TESTS,
    });
    expect(seen[0]?.text).toContain("app.set_assignment_code_tests(");
    expect(seen[0]?.values).toEqual([A, "javascript", JSON.stringify(TESTS)]);
  });

  it("refuses an answer that is not exactly one new revision", async () => {
    for (const answer of [
      [],
      [{ revisionNo: 0, language: "javascript", tests: [] }],
      [{ revisionNo: "1", language: "javascript", tests: [] }],
      [
        { revisionNo: 1, language: "javascript", tests: [] },
        { revisionNo: 2, language: "javascript", tests: [] },
      ],
    ]) {
      await expect(port(answer).port.publish(TOKEN, A, "javascript", [])).rejects.toThrow(
        "invalid published code tests revision",
      );
    }
  });
});

describe("errors", () => {
  it("passes the database's refusals through untouched", async () => {
    for (const code of ["ZD401", "ZD403", "ZD404", "ZD422"]) {
      await expect(
        port(sqlError(code)).port.publish(TOKEN, A, "javascript", []),
      ).rejects.toMatchObject({ code });
      await expect(port(sqlError(code)).port.read(TOKEN, A)).rejects.toMatchObject({ code });
    }
  });
});
