// The fake record of a restore (INT-21 C) answers as app.record_revision_restore
// does: the revision the record is against, and for already_recorded the
// latest revision that restored the same one, never the revision a client
// just saved when that one was not recorded. Every value is invented.
import { describe, expect, it } from "vitest";

import type { State } from "./state.ts";
import { VERSIONS_HANDLERS } from "./versions-routes.ts";

const STUDENT = { id: "izmisljeni-student-1" };
const OTHER = { id: "izmisljeni-student-2" };
const text = (letter: string) => Buffer.from(letter).toString("base64");

function stateWith(snapshots: [number, string][]): State {
  return {
    assignments: [],
    courses: [],
    works: [
      {
        documentId: "izmisljeni-rad-0001",
        studentId: STUDENT.id,
        versionSnapshots: new Map(snapshots.map(([revision, letter]) => [revision, text(letter)])),
      },
    ],
  } as unknown as State;
}

const restore = (state: State, fromRevision: number, account: object | null = STUDENT) =>
  (VERSIONS_HANDLERS["work.restore.post"] as (input: unknown) => unknown)({
    state,
    account,
    params: { documentId: "izmisljeni-rad-0001" },
    body: { fromRevision },
    query: {},
  });

const ok = (body: object) => ({ status: 200, body });

describe("the fake record of a restore", () => {
  it("names the revision each restore is recorded against", () => {
    const state = stateWith([
      [1, "a"],
      [2, "b"],
      [3, "a"],
      [4, "b"],
      [5, "a"],
    ]);
    expect(restore(state, 1)).toEqual(ok({ outcome: "recorded", revision: 3 }));
    expect(restore(state, 2)).toEqual(ok({ outcome: "recorded", revision: 4 }));
    expect(restore(state, 1)).toEqual(ok({ outcome: "recorded", revision: 5 }));
    expect(restore(state, 1)).toEqual(ok({ outcome: "already_recorded", revision: 5 }));
    expect(restore(state, 2)).toEqual(ok({ outcome: "already_recorded", revision: 4 }));
  });

  it("an already recorded restore names the earlier revision, not one saved since", () => {
    const state = stateWith([
      [1, "a"],
      [2, "a"],
    ]);
    expect(restore(state, 1)).toEqual(ok({ outcome: "recorded", revision: 2 }));
    // The student saves revision 3 with other text: a retry is not its confirmation.
    state.works[0]!.versionSnapshots.set(3, text("c"));
    expect(restore(state, 1)).toEqual(ok({ outcome: "already_recorded", revision: 2 }));
  });

  it("without a later revision of the same text nothing is recorded", () => {
    const state = stateWith([
      [1, "a"],
      [2, "b"],
    ]);
    expect(restore(state, 1)).toEqual(ok({ outcome: "no_matching_revision" }));
    expect(restore(state, 9)).toEqual(ok({ outcome: "no_matching_revision" }));
  });

  it("only the owner records", () => {
    const state = stateWith([
      [1, "a"],
      [2, "a"],
    ]);
    expect(restore(state, 1, OTHER)).toEqual({ error: "not_found" });
    expect(restore(state, 1, null)).toEqual({ error: "unauthorized" });
  });
});
