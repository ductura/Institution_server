// DAN-818 (VS-1 narrow cut, step 4): the contract of evidence/replay, ported
// from Ductus 333e163 replay-route.ts and replay-reader.ts (attack plan
// ductura/server#136). Only invented data.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { answerFake, FAKE_VECTOR_HEADER, VECTORS } from "./generated/fake-server/index.ts";
import { validateInput } from "./generated/index.ts";
import { ROUTES } from "./index.ts";

const REPLAY = "evidence.replay.post";
const DOC = "dokument-izmisljeni-zv-1";
const HEAD = { segmentHash: "a1".repeat(32), segmentCount: 1 };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const vector = (name: string) => {
  const found = VECTORS.find((v) => v.route === REPLAY && v.name === name);
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
};

describe("evidence/replay contract", () => {
  it("is a POST under /api/v1 that the owner and the teacher of the course may read", () => {
    const route = ROUTES.find((r) => r.id === REPLAY);
    expect(route).toMatchObject({
      method: "POST",
      path: "/api/v1/evidence/replay",
      access: "owner_or_course_teacher",
    });
    expect(route?.request.maxBodyBytes).toBe(1024);
  });

  it.each(VECTORS.filter((v) => v.route === REPLAY).map((v) => [v.name]))(
    "the fake server answers %s from its vector, never 501",
    (name) => {
      const v = vector(name);
      const answer = answerFake({
        method: "POST",
        url: "/api/v1/evidence/replay",
        headers: { ...v.request.headers, [FAKE_VECTOR_HEADER]: name },
        body: new TextEncoder().encode(v.request.rawBody ?? JSON.stringify(v.request.body)),
      });
      expect(answer.status).not.toBe(501);
      expect(answer.status).toBe(v.response.status);
    },
  );

  it.each([
    ["the first page", { documentId: DOC, from: 0 }, true],
    ["a later page with its head", { documentId: DOC, from: 3, head: HEAD }, true],
    ["an institution in the body", { documentId: DOC, from: 0, institutionId: "u-1" }, false],
    ["a role in the body", { documentId: DOC, from: 0, role: "teacher" }, false],
    ["a negative from", { documentId: DOC, from: -1 }, false],
    ["a fractional from", { documentId: DOC, from: 0.5 }, false],
    ["from as text", { documentId: DOC, from: "0" }, false],
    ["no from", { documentId: DOC }, false],
    ["no document", { from: 0 }, false],
    [
      "an uppercase head hash",
      { documentId: DOC, from: 1, head: { ...HEAD, segmentHash: "A1".repeat(32) } },
      false,
    ],
    [
      "a short head hash",
      { documentId: DOC, from: 1, head: { ...HEAD, segmentHash: "a1" } },
      false,
    ],
    ["a head count of 0", { documentId: DOC, from: 1, head: { ...HEAD, segmentCount: 0 } }, false],
    ["a head with a third key", { documentId: DOC, from: 1, head: { ...HEAD, at: 1 } }, false],
  ])("%s -> %s", (_, value, valid) => {
    expect(validateInput(REPLAY, "body", value)).toBe(valid);
  });

  it("the first page vector is a real record: hashes, chain and start document agree", () => {
    const page = vector("first-page").response.body as {
      head: { segmentHash: string; segmentCount: number };
      segments: string[];
      startDocument: string;
      next: number | null;
    };
    expect(page.segments).toHaveLength(1);
    const text = page.segments[0] as string;
    const segment = JSON.parse(text) as Record<string, unknown>;
    expect(sha256(text)).toBe(page.head.segmentHash);
    expect(page.head.segmentCount).toBe(1);
    expect(segment.documentId).toBe(DOC);
    expect(segment.predecessorSegmentHash).toBeNull();
    expect(sha256(page.startDocument)).toBe(segment.initialDocumentHash);
    expect(page.next).toBeNull();
  });

  it("a page past the end, a foreign work and a changed record never carry content", () => {
    for (const name of ["not-found-foreign-work", "not-found-past-end", "record-changed"]) {
      expect(Object.keys(vector(name).response.body as object)).toEqual(["status"]);
    }
  });

  it("an unavailable record names only its stage and asks to retry", () => {
    for (const [name, stage] of [
      ["unavailable", "context"],
      ["unavailable-storage", "storage"],
    ] as const) {
      expect(vector(name).response).toMatchObject({
        status: 503,
        headers: { "retry-after": "5" },
        body: { status: "unavailable", stage },
      });
    }
  });
});
