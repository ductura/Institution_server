// The port of mark_notice_read (SRV-10) over a scripted transaction: the
// order of its statements and the two findings of Codex on #371 (no live
// session is unauthenticated, a version published between the reads rolls the
// mark back). The database itself is tests/db/student-writes-route.integration.test.ts.
import { describe, expect, it } from "vitest";

import { createStudentNoticeRead } from "./student-notice-read.ts";
import type { WithActor } from "./with-actor.ts";

const ASSIGNMENT = "4b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d01";
const READ_AT = new Date("2026-11-19T12:00:00.000Z");

/** A withActor whose statements answer in turn from `answers`; it records them and a rollback. */
function scripted(answers: Record<string, unknown>[][]) {
  const statements: string[] = [];
  let rolledBack = false;
  const withActor = (async (_token, fn) => {
    const tx = {
      query: async (text: string) => {
        statements.push(text.split(" ").slice(0, 2).join(" "));
        return { rows: answers.shift() ?? [] };
      },
    };
    try {
      return await fn(tx as never);
    } catch (error) {
      rolledBack = true;
      throw error;
    }
  }) as WithActor;
  return { port: createStudentNoticeRead(withActor), statements, rolledBack: () => rolledBack };
}
const ACTOR = [{ userId: "izmisljeni-korisnik" }];

describe("createStudentNoticeRead", () => {
  it("reads the actor, the version, marks, reads the version again and answers readAt", async () => {
    const run = scripted([
      ACTOR,
      [{ currentVersion: 2 }],
      [{ readAt: READ_AT }],
      [{ currentVersion: 2 }],
    ]);
    expect(await run.port.markRead("t", ASSIGNMENT, 2)).toEqual({
      status: "read",
      readAt: "2026-11-19T12:00:00.000Z",
    });
    expect(run.statements).toEqual([
      "SELECT user_id",
      "SELECT a.current_version",
      "SELECT institution.mark_notice_read($1::uuid)",
      "SELECT a.current_version",
    ]);
    expect(run.rolledBack()).toBe(false);
  });

  it("is unauthenticated without a live session, before the assignment is looked at", async () => {
    const run = scripted([[{ userId: null }], []]);
    expect(await run.port.markRead("t", ASSIGNMENT, 2)).toEqual({ status: "unauthenticated" });
    expect(run.statements).toHaveLength(1);
  });

  it("is not_found for an assignment RLS hides, and conflict for another version, with no mark", async () => {
    const hidden = scripted([ACTOR, []]);
    expect(await hidden.port.markRead("t", ASSIGNMENT, 2)).toEqual({ status: "not_found" });
    const other = scripted([ACTOR, [{ currentVersion: 3 }]]);
    expect(await other.port.markRead("t", ASSIGNMENT, 2)).toEqual({ status: "conflict" });
    expect([...hidden.statements, ...other.statements]).not.toContain(
      "SELECT institution.mark_notice_read($1::uuid)",
    );
  });

  it("rolls the mark back and is conflict when a version is published between the reads", async () => {
    const run = scripted([
      ACTOR,
      [{ currentVersion: 2 }],
      [{ readAt: READ_AT }],
      [{ currentVersion: 3 }],
    ]);
    expect(await run.port.markRead("t", ASSIGNMENT, 2)).toEqual({ status: "conflict" });
    expect(run.rolledBack()).toBe(true);
  });

  it("maps ZD401 and ZD403 of the RPC, and anything else is unavailable", async () => {
    for (const [code, status] of [
      ["ZD401", "unauthenticated"],
      ["ZD403", "not_found"],
      ["XX000", "unavailable"],
    ]) {
      const port = createStudentNoticeRead((async () => {
        throw Object.assign(new Error("izmišljeno"), { code });
      }) as WithActor);
      expect(await port.markRead("t", ASSIGNMENT, 2)).toEqual({ status });
    }
  });
});
