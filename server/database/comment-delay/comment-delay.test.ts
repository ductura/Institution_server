// The port of the delayed comments and the review mark (SRV-1703) over a
// scripted transaction: the SQL and parameters each call sends, the mapping of
// rows, and the closed statuses for database errors and rows of an unexpected
// shape. The database itself is db/main/tests/201-comment-delay-bank.sql.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createCommentDelay } from "./comment-delay.ts";

const ID = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e01";
const AT = new Date("2026-11-21T09:00:00.000Z");
const ANCHOR = { nodeId: ID, quote: "odlomak", prefix: "", suffix: "", startHint: 0, endHint: 7 };

function scripted(rows: Record<string, unknown>[], error?: unknown) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const withActor = (async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (error !== undefined) throw error;
        return { rows, rowCount: rows.length };
      },
    } as never)) as WithActor;
  return { port: createCommentDelay(withActor), calls };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });
const DRAFT = {
  threadId: ID,
  commentId: ID,
  position: 1,
  text: "Izmišljena napomena.",
  anchor: ANCHOR,
  state: "open",
  createdWindow: AT,
};

describe("createCommentDelay", () => {
  it("creates a draft thread with the anchor as JSON", async () => {
    const run = scripted([{ id: ID }]);
    expect(await run.port.createDraft("t", "doc-a", "Tekst.", ANCHOR)).toEqual({
      status: "ok",
      threadId: ID,
    });
    expect(run.calls[0]!.text).toContain("collaboration.create_comment_draft($1, $2, $3::jsonb)");
    expect(run.calls[0]!.values).toEqual(["doc-a", "Tekst.", JSON.stringify(ANCHOR)]);
  });

  it("drafts a reply, lists drafts, discards one and publishes", async () => {
    expect(await scripted([{ id: ID }]).port.replyDraft("t", "doc-a", ID, "Tekst.")).toEqual({
      status: "ok",
      commentId: ID,
    });
    const listed = await scripted([DRAFT]).port.listDrafts("t", "doc-a");
    expect(listed).toEqual({
      status: "ok",
      drafts: [{ ...DRAFT, createdWindow: "2026-11-21T09:00:00.000Z" }],
    });
    expect(
      await scripted([{ ...DRAFT, anchor: null }]).port.listDrafts("t", "doc-a"),
    ).toMatchObject({
      status: "ok",
      drafts: [{ anchor: null }],
    });
    const discard = scripted([{}]);
    expect(await discard.port.discardDraft("t", ID)).toEqual({ status: "ok" });
    expect(discard.calls[0]!.text).toContain("collaboration.discard_comment_draft($1::uuid)");
    const publish = scripted([{ published: 3 }]);
    expect(await publish.port.publish("t", "doc-a")).toEqual({ status: "ok", published: 3 });
    expect(publish.calls[0]!.values).toEqual(["doc-a"]);
  });

  it("marks a work reviewed and reads the review state with bigint columns as text", async () => {
    expect(
      await scripted([{ reviewedRevision: "4", reviewedAt: AT }]).port.markReviewed("t", "doc-a"),
    ).toEqual({ status: "ok", reviewedRevision: 4, reviewedAt: "2026-11-21T09:00:00.000Z" });
    expect(
      await scripted([{ reviewedRevision: null, currentRevision: "7" }]).port.reviewState(
        "t",
        "doc-a",
      ),
    ).toEqual({ status: "ok", reviewedRevision: null, currentRevision: 7 });
    expect(
      await scripted([{ reviewedRevision: "2", currentRevision: "7" }]).port.reviewState(
        "t",
        "doc-a",
      ),
    ).toEqual({ status: "ok", reviewedRevision: 2, currentRevision: 7 });
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid"],
    ["08006", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    expect(await scripted([], dbError(code)).port.publish("t", "doc-a")).toEqual({ status });
    expect(await scripted([], dbError(code)).port.listDrafts("t", "doc-a")).toEqual({ status });
  });

  it("answers unavailable for a malformed row or a throwing error code", async () => {
    for (const row of [
      { ...DRAFT, state: "published" },
      { ...DRAFT, anchor: 5 },
      { ...DRAFT, createdWindow: "nije datum" },
      { ...DRAFT, position: 1.5 },
    ]) {
      expect(await scripted([row]).port.listDrafts("t", "doc-a")).toEqual({
        status: "unavailable",
      });
    }
    expect(await scripted([{ published: 0 }]).port.publish("t", "doc-a")).toEqual({
      status: "unavailable",
    });
    expect(await scripted([]).port.createDraft("t", "doc-a", "x", ANCHOR)).toEqual({
      status: "unavailable",
    });
    expect(
      await scripted([{ reviewedRevision: "0", reviewedAt: AT }]).port.markReviewed("t", "d"),
    ).toEqual({ status: "unavailable" });
    expect(
      await scripted([{ reviewedRevision: "x", currentRevision: "1" }]).port.reviewState("t", "d"),
    ).toEqual({ status: "unavailable" });
    const hostile = {
      get code(): string {
        throw new Error("nema koda");
      },
    };
    expect(await scripted([], hostile).port.publish("t", "doc-a")).toEqual({
      status: "unavailable",
    });
  });

  describe("publishListed", () => {
    const ID2 = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e02";
    /** One answer per query, in order. */
    function sequenced(answers: Record<string, unknown>[][]) {
      const calls: string[] = [];
      const withActor = (async (_token, fn) =>
        fn({
          query: async (text: string) => {
            calls.push(text);
            const rows = answers[calls.length - 1] ?? [];
            return { rows, rowCount: rows.length };
          },
        } as never)) as WithActor;
      return { port: createCommentDelay(withActor), calls };
    }
    const drafts = [DRAFT, { ...DRAFT, commentId: ID2, position: 2 }];

    it("publishes when the ids are exactly the caller's drafts, in any case and order", async () => {
      const run = sequenced([drafts, [{ published: 2 }]]);
      expect(await run.port.publishListed("t", "doc-a", [ID2.toUpperCase(), ID])).toEqual({
        status: "ok",
        published: 2,
      });
      expect(run.calls[0]).toContain("collaboration.list_comment_drafts($1)");
      expect(run.calls[1]).toContain("collaboration.publish_comments($1)");
    });

    it.each([
      ["an id that is not a draft", [ID, "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e09"]],
      ["a draft the teacher did not see", [ID]],
      ["the same id twice", [ID, ID.toUpperCase()]],
    ])("is a conflict and publishes nothing for %s", async (_, ids) => {
      const run = sequenced([drafts, [{ published: 2 }]]);
      expect(await run.port.publishListed("t", "doc-a", ids)).toEqual({ status: "conflict" });
      expect(run.calls).toHaveLength(1);
    });

    it("is a conflict when no draft is left", async () => {
      const run = sequenced([[], [{ published: 1 }]]);
      expect(await run.port.publishListed("t", "doc-a", [ID])).toEqual({ status: "conflict" });
      expect(run.calls).toHaveLength(1);
    });

    it("is a conflict when the publish counts a draft written after the list", async () => {
      const run = sequenced([drafts, [{ published: 3 }]]);
      expect(await run.port.publishListed("t", "doc-a", [ID, ID2])).toEqual({
        status: "conflict",
      });
    });
  });
});
