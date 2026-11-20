// SRV-22 (Ductus#2028 c.7009405737): student.assignment-requirements.get over
// a fake port. No bound at either end is a null range; the refusals map as in
// student.submission.get. All values are invented.
import { describe, expect, it } from "vitest";

import type { MySubmissionStateReader } from "../database/index.ts";

import { readStudentRequirements } from "./student-requirements-route.ts";

const TOKEN = "izmisljeni-token-stanja-predaje-00000000001";
const A = "00000000-0000-4000-8000-0000000000a1";

function port(answer: Awaited<ReturnType<MySubmissionStateReader["requirements"]>>) {
  const calls: unknown[][] = [];
  const reader: MySubmissionStateReader = {
    state: () => Promise.reject(new Error("not this read")),
    requirements: async (...args) => (calls.push(args), answer),
  };
  return { reader, calls };
}

describe("student.assignment-requirements.get", () => {
  it("maps the port's refusals: unauthenticated 401, not_found 404, anything else 503", async () => {
    const cases: [string, number][] = [
      ["MY_SUBMISSION_STATE_UNAUTHENTICATED", 401],
      ["MY_SUBMISSION_STATE_NOT_FOUND", 404],
      ["MY_SUBMISSION_STATE_ROW_MALFORMED", 503],
      ["MY_SUBMISSION_STATE_DATABASE_ERROR", 503],
    ];
    for (const [code, status] of cases) {
      const answer = { ok: false as const, error: { code, messageKey: "x.y" } };
      expect(await readStudentRequirements(port(answer).reader, TOKEN, A)).toEqual({ status });
    }
  });

  it.each([
    [null, null, null],
    [800, 1200, { min: 800, max: 1200 }],
    [800, null, { min: 800, max: null }],
    [null, 1200, { min: null, max: 1200 }],
  ])("bounds %s and %s read as %j", async (wordMin, wordMax, wordRange) => {
    const { reader, calls } = port({ ok: true, value: { wordMin, wordMax } });
    expect(await readStudentRequirements(reader, TOKEN, A)).toEqual({
      status: 200,
      body: { wordRange },
    });
    expect(calls).toEqual([[TOKEN, A]]);
  });
});
