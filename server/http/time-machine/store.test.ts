import { expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { STORAGE_NOT_CONFIGURED } from "../index.ts";

import { createTimeMachineStore } from "./store.ts";

const SAVED_MINUTE = new Date("2026-11-20T12:00:00.000Z");
const SUBMISSION = {
  outcome: "found",
  kind: "submission",
  revision: "2",
  savedMinute: SAVED_MINUTE,
  afterDeadline: false,
};
const CHECKPOINT = {
  outcome: "found",
  kind: "checkpoint",
  revision: "1",
  savedMinute: SAVED_MINUTE,
  afterDeadline: null,
};

function storeWith(...answers: Record<string, unknown>[][]) {
  const query = vi.fn((_sql: string) => {
    const rows = answers.shift();
    if (rows === undefined) throw new Error("unexpected query");
    return rows;
  });
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(sql: string) {
        const rows = query(sql) as Row[];
        return { rows, rowCount: rows.length };
      },
    });
  return { store: createTimeMachineStore(withActor, STORAGE_NOT_CONFIGURED), query };
}

it("keeps drafts out of a mentor's list and denies work unrelated to the actor", async () => {
  const { store, query } = storeWith(
    [{ viewer: "mentor" }],
    [SUBMISSION, CHECKPOINT],
    [],
    [{ viewer: "mentor" }],
    [{ viewer: null }],
  );
  expect(await store.list("synthetic-mentor", "doc-demo", null)).toStrictEqual({
    status: "found",
    versions: [
      {
        kind: "submission",
        revision: 2,
        savedMinute: SAVED_MINUTE.toISOString(),
        afterDeadline: false,
      },
    ],
    nextBeforeRevision: null,
  });
  expect(await store.list("synthetic-other", "doc-demo", null)).toEqual({ status: "not_found" });
  expect(query).toHaveBeenCalledTimes(5);
});

it("requires an explicit send for each revision before reading comparison snapshots", async () => {
  const { store, query } = storeWith(
    [{ viewer: "owner" }],
    [SUBMISSION, CHECKPOINT],
    [{ sent: false }],
  );
  expect(await store.read("synthetic-owner", "doc-demo", [1, 2])).toStrictEqual({
    status: "not_found",
  });
  expect(query).toHaveBeenCalledTimes(3);
  expect(query.mock.calls[2]?.[0]).toContain("response_kind = 'done'");
});

it("reads both authorized owner snapshots in revision order", async () => {
  const earlier = { body: "Izmišljena verzija za pregled.", hash: "a".repeat(64) };
  const later = { body: "Izmišljena predaja.", hash: "b".repeat(64) };
  const { store, query } = storeWith(
    [{ viewer: "owner" }],
    [SUBMISSION, CHECKPOINT],
    [{ sent: true }],
    [earlier],
    [later],
    [{ viewer: "owner" }],
  );
  expect(await store.read("synthetic-owner", "doc-demo", [1, 2])).toStrictEqual({
    status: "found",
    snapshots: [earlier, later],
  });
  expect(query.mock.calls[3]?.[0]).toContain("app.read_own_reconstruction_checkpoint");
});

it("rechecks active mentorship after reading a submitted snapshot", async () => {
  const { store, query } = storeWith(
    [{ viewer: "mentor" }],
    [SUBMISSION, CHECKPOINT],
    [{ body: "Izmišljena predaja.", hash: "a".repeat(64) }],
    [{ viewer: null }],
  );
  expect(await store.read("synthetic-mentor", "doc-demo", [2])).toStrictEqual({
    status: "not_found",
  });
  expect(query.mock.calls[2]?.[0]).toContain("outcome = 'submitted'");
  expect(query.mock.calls[3]).toEqual(query.mock.calls[0]);
});
