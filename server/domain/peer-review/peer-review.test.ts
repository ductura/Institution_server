import { describe, expect, it } from "vitest";

import { anonymousBlocks, anonymousReview, anonymousRubrics } from "./index.ts";

// docs/contracts/peer-review-v1.md §3: the answers a student reads carry no
// identifier of a person, a work or a task. Each row below carries all of them
// next to the allowed fields; the answer is searched as a whole JSON string.
// Everything here is invented.
const PERSON = "00000000-0000-4000-8000-00000000a001";
const AUTHOR = "00000000-0000-4000-8000-00000000a002";
const WORK = "00000000-0000-4000-8000-00000000b001";
const TASK = "00000000-0000-4000-8000-00000000c001";
const BLOCK = "00000000-0000-4000-8000-00000000d001";
const NAME = "Ivana Izmišljena";
const LEAKS = [PERSON, AUTHOR, WORK, TASK, BLOCK, NAME, "ivana@ductura.example.invalid"];
const extra = {
  reviewerId: PERSON,
  authorId: AUTHOR,
  submissionId: WORK,
  taskId: TASK,
  blockId: BLOCK,
  name: NAME,
  email: "ivana@ductura.example.invalid",
  marks: [{ type: "comment", by: PERSON }],
  attrs: { author: NAME },
};
const leaked = (answer: unknown) => LEAKS.filter((leak) => JSON.stringify(answer).includes(leak));

describe("the work a reviewer reads", () => {
  it("keeps only kind and text, in document order, and drops the row of a work with no block", () => {
    const rows = [
      { ord: 2, kind: "paragraph", body: "Drugi odlomak.", ...extra },
      { ord: 1, kind: "heading", body: "Naslov", ...extra },
      { ord: 3, kind: "list_item", body: "Stavka", ...extra },
    ];
    const blocks = anonymousBlocks(rows);
    expect(blocks).toEqual([
      { kind: "heading", text: "Naslov" },
      { kind: "paragraph", text: "Drugi odlomak." },
      { kind: "list_item", text: "Stavka" },
    ]);
    expect(leaked(blocks)).toEqual([]);
    expect(anonymousBlocks([{ ord: null, kind: null, body: null }])).toEqual([]);
  });

  it("keeps only key and label of a rubric", () => {
    const rubrics = anonymousRubrics([{ key: "clarity", label: "Jasnoća", ...extra }]);
    expect(rubrics).toEqual([{ key: "clarity", label: "Jasnoća" }]);
    expect(leaked(rubrics)).toEqual([]);
  });

  it("refuses a block kind the contract does not know instead of renaming it", () => {
    expect(() => anonymousBlocks([{ ord: 1, kind: "signature", body: NAME }])).toThrow();
    expect(() => anonymousBlocks([{ ord: 1, kind: "paragraph", body: null }])).toThrow();
  });
});

describe("the reviews an author receives", () => {
  it("keeps the review id, the texts by rubric, the general comment and the time, nothing else", () => {
    const review = anonymousReview({
      reviewId: "00000000-0000-4000-8000-00000000e001",
      byRubric: [{ key: "clarity", label: "Jasnoća", text: "Jasno napisano.", ...extra }],
      general: null,
      submittedAt: new Date("2026-12-02T10:00:00Z"),
      ...extra,
    } as never);
    expect(review).toEqual({
      reviewId: "00000000-0000-4000-8000-00000000e001",
      byRubric: [{ key: "clarity", label: "Jasnoća", text: "Jasno napisano." }],
      general: null,
      submittedAt: "2026-12-02T10:00:00.000Z",
    });
    expect(leaked(review)).toEqual([]);
  });

  it("refuses a review without a time or with a broken text", () => {
    const base = { reviewId: "r", byRubric: [], general: null, submittedAt: new Date(Number.NaN) };
    expect(() => anonymousReview(base)).toThrow();
    expect(() =>
      anonymousReview({
        ...base,
        submittedAt: new Date(0),
        byRubric: [{ key: "a", label: "A", text: 1 }],
      }),
    ).toThrow();
  });
});
