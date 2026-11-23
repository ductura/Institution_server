// INT-27: the fake list of versions names every saved revision as a checkpoint,
// newest first, as the contract describes, so a comparison of two versions can
// be tried locally. Every value is invented.
import { describe, expect, it } from "vitest";

import type { State } from "./state.ts";
import { recordVersionSaved, VERSIONS_HANDLERS } from "./versions-routes.ts";

const STUDENT = { id: "izmisljeni-student-1" };
const DOC = "izmisljeni-rad-0001";
const text = (letter: string) => Buffer.from(letter).toString("base64");

function stateWith(
  revisions: number[],
  options: { submittedAt?: string; lastChangeAt?: string | null } = {},
): State {
  const last = revisions.length === 0 ? 0 : Math.max(...revisions);
  const state = {
    assignments: [{ id: "izmisljeni-zadatak", content: { dueAt: "2026-11-20T12:00:00.000Z" } }],
    courses: [],
    mentorships: [],
    revisionRequests: [],
    works: [
      {
        documentId: DOC,
        studentId: STUDENT.id,
        assignmentId: "izmisljeni-zadatak",
        revision: last,
        submittedAt: options.submittedAt ?? null,
        lastChangeAt:
          options.lastChangeAt === undefined ? "2026-11-19T10:59:30.000Z" : options.lastChangeAt,
        versionSnapshots: new Map(revisions.map((revision) => [revision, text(String(revision))])),
      },
    ],
  } as unknown as State;
  for (const revision of revisions) {
    if (revision === last) continue;
    const minute = String(revision % 60).padStart(2, "0");
    recordVersionSaved(state, DOC, revision, `2026-11-19T10:${minute}:15.000Z`);
  }
  return state;
}

type Listed = {
  status: number;
  body: { versions: Record<string, unknown>[]; nextBeforeRevision: number | null };
};
const list = (state: State, query: Record<string, string> = {}) =>
  (VERSIONS_HANDLERS["work.versions.get"] as (input: unknown) => Listed)({
    state,
    account: STUDENT,
    params: { documentId: DOC },
    query,
    body: undefined,
  });

describe("the fake list of versions", () => {
  it("names every saved revision as a checkpoint, newest first, on its whole minute", () => {
    const { status, body } = list(stateWith([1, 2, 3]));
    expect(status).toBe(200);
    expect(body).toEqual({
      versions: [
        { kind: "checkpoint", revision: 3, savedMinute: "2026-11-19T10:59:00.000Z" },
        { kind: "checkpoint", revision: 2, savedMinute: "2026-11-19T10:02:00.000Z" },
        { kind: "checkpoint", revision: 1, savedMinute: "2026-11-19T10:01:00.000Z" },
      ],
      nextBeforeRevision: null,
    });
  });

  it("puts the submission before the checkpoint of its revision", () => {
    const { body } = list(stateWith([1, 2], { submittedAt: "2026-11-21T08:30:45.000Z" }));
    expect(body.versions).toEqual([
      {
        kind: "submission",
        revision: 2,
        savedMinute: "2026-11-21T08:30:00.000Z",
        afterDeadline: true,
      },
      { kind: "checkpoint", revision: 2, savedMinute: "2026-11-19T10:59:00.000Z" },
      { kind: "checkpoint", revision: 1, savedMinute: "2026-11-19T10:01:00.000Z" },
    ]);
  });

  it("names the restored revision on the checkpoint that restored it", async () => {
    const state = stateWith([1, 2, 3]);
    state.works[0]!.versionSnapshots.set(3, text("1"));
    const restore = VERSIONS_HANDLERS["work.restore.post"] as (input: unknown) => unknown;
    expect(
      restore({
        state,
        account: STUDENT,
        params: { documentId: DOC },
        body: { fromRevision: 1 },
        query: {},
      }),
    ).toEqual({ status: 200, body: { outcome: "recorded", revision: 3 } });
    expect(list(state).body.versions[0]).toEqual({
      kind: "checkpoint",
      revision: 3,
      savedMinute: "2026-11-19T10:59:00.000Z",
      restoredFromRevision: 1,
    });
    expect(list(state).body.versions[1]).not.toHaveProperty("restoredFromRevision");
  });

  it("beforeRevision lists only the versions below it", () => {
    const { body } = list(stateWith([1, 2, 3]), { beforeRevision: "3" });
    expect(body.versions.map((v) => v.revision)).toEqual([2, 1]);
    expect(body.nextBeforeRevision).toBeNull();
  });

  it("pages at 200 without splitting a revision", () => {
    const revisions = Array.from({ length: 205 }, (_, index) => index + 1);
    const state = stateWith(revisions, { submittedAt: "2026-11-21T08:30:45.000Z" });
    const first = list(state).body;
    // The submission and the checkpoint of 205 count two, so 199 revisions fit.
    expect(first.versions).toHaveLength(200);
    expect(first.versions.at(-1)!.revision).toBe(7);
    expect(first.nextBeforeRevision).toBe(7);
    const second = list(state, { beforeRevision: String(first.nextBeforeRevision) }).body;
    expect(second.versions.map((v) => v.revision)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(second.nextBeforeRevision).toBeNull();
  });

  it("a seeded work without saved snapshots still lists only its current revision", () => {
    const state = stateWith([]);
    state.works[0]!.revision = 4;
    expect(list(state).body.versions).toEqual([
      { kind: "checkpoint", revision: 4, savedMinute: "2026-11-19T10:59:00.000Z" },
    ]);
  });

  it("a snapshot without a recorded save time is not listed", () => {
    const state = stateWith([2]);
    state.works[0]!.versionSnapshots.set(1, text("1"));
    expect(list(state).body.versions.map((v) => v.revision)).toEqual([2]);
  });
});
