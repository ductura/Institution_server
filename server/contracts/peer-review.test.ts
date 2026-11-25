// SRV-V19-RECENZIJA-UGOVOR: the closed inputs of the peer review and, above
// all, its anonymity. What the reviewer reads and what the author receives are
// closed shapes that have no place for a person, so none can leak through a
// route that is later ported; the vectors are checked the same way.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";
import {
  PEER_REVIEW_MIN_SUBMISSIONS,
  peerReviewMinSubmissions,
  peerReviewRoundPut,
  peerReviewRoutes,
  studentPeerReviewPost,
} from "./routes/index.ts";

const IDS = peerReviewRoutes.map((r) => r.id);
const route = (id: string) => ROUTES.find((r) => r.id === id)!;

/** Every property name that appears anywhere in a (TypeBox) schema. */
function names(schema: unknown, into = new Set<string>()): Set<string> {
  if (schema === null || typeof schema !== "object") return into;
  const s = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries((s.properties ?? {}) as object)) {
    into.add(key);
    names(value, into);
  }
  for (const part of ["items", "anyOf", "oneOf", "allOf"] as const) {
    const sub = s[part];
    for (const item of Array.isArray(sub) ? sub : [sub]) names(item, into);
  }
  return into;
}
/** Every key of a JSON value. */
function keys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      keys(item, into);
    }
  }
  return into;
}

/** Fields that name or lead to a person, a work, an allocation or a course. */
const IDENTITY = [
  "id",
  "studentId",
  "authorId",
  "reviewerId",
  "principalId",
  "documentId",
  "workId",
  "assignmentId",
  "courseId",
  "givenName",
  "familyName",
  "name",
  "email",
  "author",
  "reviewer",
  "mentor",
  "taskId",
  "allocationId",
  "roundId",
];
/** Fields of a grade, a score or a rank: none in this contract (the grade stays in Merlin). */
const GRADING = ["score", "grade", "points", "rank", "rating", "percent", "total", "position"];
const anonymous = ["student.peer-review-work.get", "student.peer-reviews-received.get"];

describe("peer review contract", () => {
  it("has nine routes, none of which changes an existing contract", () => {
    expect(IDS).toEqual([
      "peer-review.round.put",
      "peer-review.round.get",
      "peer-review.allocate.post",
      "peer-review.teacher-overview.get",
      "peer-review.review-withdrawal.post",
      "student.peer-review-tasks.get",
      "student.peer-review-work.get",
      "student.peer-review.post",
      "student.peer-reviews-received.get",
    ]);
    expect(IDS.every((id) => ROUTES.some((r) => r.id === id))).toBe(true);
  });

  it("answers the reviewer and the author with no field that leads to a person", () => {
    for (const id of anonymous) {
      const found = names(route(id).responses[0]!.body);
      expect(found.size, id).toBeGreaterThan(0);
      expect(
        IDENTITY.filter((field) => found.has(field)),
        id,
      ).toEqual([]);
    }
    // The only id a student's answer holds is the one of what they act on.
    expect([...names(route("student.peer-review-tasks.get").responses[0]!.body)].sort()).toEqual([
      "dueAt",
      "state",
      "taskId",
      "tasks",
    ]);
    expect([...names(route("student.peer-review.post").responses[0]!.body)]).toEqual(["reviewId"]);
  });

  it("answers the reviewer and the author the same way in every vector", () => {
    for (const id of anonymous) {
      const file = JSON.parse(
        readFileSync(new URL(`./vectors/${id}.json`, import.meta.url), "utf8"),
      ) as { vectors: { kind: string; response: { body?: unknown } }[] };
      const successes = file.vectors.filter((v) => v.kind === "success");
      expect(successes.length, id).toBeGreaterThan(0);
      for (const vector of successes) {
        expect(IDENTITY.filter((f) => keys(vector.response.body).has(f))).toEqual([]);
      }
    }
  });

  it("carries no grade, score or rank anywhere", () => {
    for (const r of peerReviewRoutes) {
      const found = new Set<string>();
      for (const spec of r.responses) names(spec.body, found);
      if ("body" in r.request) names(r.request.body, found);
      expect(
        GRADING.filter((field) => found.has(field)),
        r.id,
      ).toEqual([]);
    }
  });

  it("gives the reviewer blocks of a kind and a text only: no metadata of a block can name the author", () => {
    const body = route("student.peer-review-work.get").responses[0]!.body!;
    const doc = (blocks: unknown) =>
      Value.Check(body, {
        rubrics: [{ key: "a", label: "A" }],
        document: { blocks },
      });
    expect(doc([{ kind: "paragraph", text: "Izmisljen tekst." }])).toBe(true);
    expect(doc([])).toBe(true);
    for (const extra of [
      { author: "Student A" },
      { authorId: "00000000-0000-4000-8000-00000000b301" },
      { attrs: { id: "x" } },
      { marks: [] },
      { createdAt: "2026-04-01T08:00:00.000Z" },
      { id: "b1" },
    ]) {
      expect(doc([{ kind: "paragraph", text: "x", ...extra }]), JSON.stringify(extra)).toBe(false);
    }
    // A title page and a signature are no kind of block of this answer.
    for (const kind of ["title_page", "cover", "signature", "metadata", "author"]) {
      expect(doc([{ kind, text: "x" }]), kind).toBe(false);
    }
    // And the answer holds nothing about the document beyond its blocks.
    expect(
      Value.Check(body, {
        rubrics: [{ key: "a", label: "A" }],
        document: { blocks: [], title: "Izmisljen naslov" },
      }),
    ).toBe(false);
    expect(
      Value.Check(body, {
        rubrics: [{ key: "a", label: "A" }],
        document: { blocks: [] },
        authorId: "x",
      }),
    ).toBe(false);
  });

  it("asks for enough submitted works for the author to stay unknown", () => {
    expect(PEER_REVIEW_MIN_SUBMISSIONS).toBe(5);
    expect([1, 2, 3].map(peerReviewMinSubmissions)).toEqual([5, 5, 7]);
    // Never fewer than twice the reviews plus one: with fewer, no allocation without
    // self-review and without two students reviewing each other exists.
    for (const k of [1, 2, 3]) {
      expect(peerReviewMinSubmissions(k)).toBeGreaterThanOrEqual(2 * k + 1);
      expect(peerReviewMinSubmissions(k)).toBeGreaterThanOrEqual(5);
    }
    const get = route("peer-review.round.get").responses[0]!.body!;
    const answer = { round: null, state: "none", submittedWorks: 0 };
    expect(Value.Check(get, { ...answer, minSubmissions: 5 })).toBe(true);
    expect(Value.Check(get, { ...answer, minSubmissions: 4 })).toBe(false);
    expect(route("peer-review.allocate.post").errors.map((e) => e.code)).toContain(
      "too_few_submissions",
    );
  });

  const round = {
    opensAt: "2026-04-06T08:00:00.000Z",
    dueAt: "2026-04-13T20:00:00.000Z",
    reviewsPerStudent: 2,
    rubrics: [{ key: "argument", label: "Jasnoca argumenta" }],
  };
  const okRound = (b: unknown) => Value.Check(peerReviewRoundPut.request.body!, b);

  it("accepts a round of one to three reviews and one to six rubrics", () => {
    expect(okRound(round)).toBe(true);
    expect(okRound({ ...round, reviewsPerStudent: 3 })).toBe(true);
    const six = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, label: `Kriterij ${i}` }));
    expect(okRound({ ...round, rubrics: six })).toBe(true);
  });

  it.each([
    ["no reviews", { ...round, reviewsPerStudent: 0 }],
    ["four reviews", { ...round, reviewsPerStudent: 4 }],
    ["fractional reviews", { ...round, reviewsPerStudent: 1.5 }],
    ["no rubrics", { ...round, rubrics: [] }],
    [
      "seven rubrics",
      { ...round, rubrics: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, label: "K" })) },
    ],
    ["upper-case key", { ...round, rubrics: [{ key: "Argument", label: "A" }] }],
    ["key of 41 characters", { ...round, rubrics: [{ key: `a${"b".repeat(40)}`, label: "A" }] }],
    ["blank label", { ...round, rubrics: [{ key: "a", label: " " }] }],
    ["label of 121 points", { ...round, rubrics: [{ key: "a", label: "x".repeat(121) }] }],
    ["label over two lines", { ...round, rubrics: [{ key: "a", label: "a\nb" }] }],
    ["date without a time", { ...round, opensAt: "2026-04-06" }],
    ["a points field", { ...round, rubrics: [{ key: "a", label: "A", points: 5 }] }],
    ["an unknown field", { ...round, anonymous: false }],
  ])("refuses a round with %s", (_name, body) => {
    expect(okRound(body)).toBe(false);
  });

  const review = { byRubric: [{ key: "argument", text: "Izmisljena recenzija." }] };
  const okReview = (b: unknown) => Value.Check(studentPeerReviewPost.request.body!, b);

  it("accepts a review of text up to 4000 points with newline and tab, and a general comment", () => {
    expect(okReview(review)).toBe(true);
    expect(okReview({ ...review, general: "Opci komentar." })).toBe(true);
    expect(okReview({ byRubric: [{ key: "a", text: "a\n\t".padEnd(4000, "b") }] })).toBe(true);
  });

  it.each([
    ["no rubric", { byRubric: [] }],
    ["blank text", { byRubric: [{ key: "a", text: " \n" }] }],
    ["text of 4001 points", { byRubric: [{ key: "a", text: "x".repeat(4001) }] }],
    ["general of 4001 points", { ...review, general: "x".repeat(4001) }],
    ["blank general", { ...review, general: " " }],
    ["bidi control", { byRubric: [{ key: "a", text: "a‮b" }] }],
    ["control character", { byRubric: [{ key: "a", text: "a\u0000b" }] }],
    ["a score", { ...review, score: 5 }],
    ["an author", { ...review, authorId: "00000000-0000-4000-8000-00000000b301" }],
  ])("refuses a review with %s", (_name, body) => {
    expect(okReview(body)).toBe(false);
  });
});
