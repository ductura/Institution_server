import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  digestSubmissionReceiptPayloadV2,
  isEvidenceSegmentV2,
  isSignedSubmissionReceiptV2,
  REVISION_ZERO_JCS,
  REVISION_ZERO_SHA256,
} from "../../server/domain/index.ts";
import { initialCommit, seedSubmission } from "./seed-predaja.ts";

it("sends a valid first segment whose final hash matches the edited snapshot", () => {
  const work = {
    status: "opened" as const,
    documentId: "izmisljeni-rad",
    document: Buffer.from(REVISION_ZERO_JCS).toString("base64"),
    documentHash: REVISION_ZERO_SHA256,
    evidenceProfileId: "standard-v1",
    currentRevision: 0,
  };
  const instant = "2026-11-20T08:00:00.000Z";
  const text = "Izmišljeni tekst o gradskim vrtovima.";
  const body = initialCommit(work, text, instant);
  const segment: unknown = JSON.parse(
    Buffer.from(body.segments[0] ?? "", "base64").toString("utf8"),
  );
  const snapshot = Buffer.from(body.document, "base64").toString("utf8");
  expect(isEvidenceSegmentV2(segment)).toBe(true);
  expect(segment).toMatchObject({
    predecessorSegmentHash: null,
    initialDocumentHash: REVISION_ZERO_SHA256,
    finalDocumentHash: createHash("sha256").update(snapshot).digest("hex"),
  });
  expect(snapshot).toContain(text);
  expect(initialCommit(work, text, instant)).toEqual(body);
  expect(() => initialCommit({ ...work, documentHash: "0".repeat(64) }, text, instant)).toThrow();
});

it("reuses enrollment, acknowledgment and revision across two seed runs", async () => {
  const vector = new URL(
    "../../server/contracts/vectors/submission.submit.post.json",
    import.meta.url,
  );
  const data = JSON.parse(readFileSync(vector, "utf8")) as {
    vectors: { name: string; response: { body: { receipt: unknown } } }[];
  };
  const receipt = data.vectors.find(({ name }) => name === "submitted")?.response.body.receipt;
  if (!isSignedSubmissionReceiptV2(receipt)) throw new Error("Missing submission vector");
  const { assignmentId, documentId } = receipt.payload;
  receipt.payload.revision = 1;
  receipt.payloadDigestSha256 = (await digestSubmissionReceiptPayloadV2(receipt.payload)).sha256;
  const scenario = {
    code: "IZMISLJENI1",
    course: "Izmišljeni kolegij",
    title: "Izmišljeni zadatak",
    text: "Izmišljeni tekst.",
    afterDeadline: false,
  };
  const calls: string[] = [];
  const api = async (path: string, body?: object) => {
    calls.push(path);
    const called = (suffix: string) => calls.some((call) => call.endsWith(suffix));
    switch (path) {
      case "student/assignments":
        return Response.json({
          courses: called("/enrollments")
            ? [
                {
                  name: scenario.course,
                  assignments: [{ id: assignmentId, title: scenario.title }],
                },
              ]
            : [],
        });
      case `student/assignments/${assignmentId}/notice`:
        return Response.json({
          assignmentId,
          versionNo: 1,
          readAt: null,
          acknowledgedAt: called("/acknowledgment") ? "acked" : null,
          templateVersion: 1,
          title: scenario.title,
          instructions: "Izmišljene upute.",
          workType: "short_paper",
          opensAt: "2026-11-01T07:00:00.000Z",
          dueAt: "2027-01-31T22:59:00.000Z",
          aiPolicy: "prohibited",
          aiPurposes: [],
          evidenceProfile: "basic",
          wordMin: null,
          wordMax: null,
        });
      case "evidence/open":
        return Response.json({
          status: "opened",
          documentId,
          document: Buffer.from(REVISION_ZERO_JCS).toString("base64"),
          documentHash: REVISION_ZERO_SHA256,
          evidenceProfileId: "standard-v1",
          currentRevision: called("/commit") ? 1 : 0,
        });
      case "evidence/commit":
        expect(body).toMatchObject({ documentId, baseRevision: 0 });
        return Response.json({ revision: 1 });
      case "submission":
        expect(body).toEqual({ documentId, revision: 1 });
        return Response.json({ status: "submitted", receipt });
      case "student/assignment-work":
        return Response.json({ assignments: [{ assignmentId, workState: "submitted" }] });
      default:
        return Response.json({});
    }
  };
  await seedSubmission(api, scenario);
  const secondRun = calls.length;
  await seedSubmission(api, scenario);
  expect(calls.slice(secondRun).filter((path) => path !== "student/assignments")).toEqual([
    `student/assignments/${assignmentId}/notice`,
    "evidence/open",
    "submission",
    "submission",
    "student/assignment-work",
  ]);
  expect(calls.filter((path) => path === "evidence/commit")).toHaveLength(1);
  expect(calls.filter((path) => path.endsWith("/acknowledgment"))).toHaveLength(1);
});
