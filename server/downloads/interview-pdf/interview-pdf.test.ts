import { createHash } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { interviewPdfHr } from "../../../locales/index.ts";

import { renderInterviewPdf, type InterviewPdfInput } from "./interview-pdf.ts";

const QUESTION = "c0300000-0000-4000-8000-000000000001";
const INTERVIEW: InterviewPdfInput = {
  documentId: "demo-rad",
  invitedAt: "2026-11-20T10:00:00.000Z",
  questions: [
    { id: QUESTION, paragraphRef: "p-3", questionText: "Kako je nastao ovaj odlomak?" },
    {
      id: "c0300000-0000-4000-8000-000000000002",
      paragraphRef: null,
      questionText: "Što je bio prvi korak?",
    },
  ],
  explanations: [
    { questionId: QUESTION, text: "Izmišljeno objašnjenje: pisao sam ga u dva navrata." },
    { questionId: null, text: "Opće izmišljeno objašnjenje." },
  ],
  appointment: { place: "Ured 12", at: "2026-11-25T09:30:00.000Z" },
  heldOn: null,
};

const textOf = async (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

describe("interview PDF", () => {
  it("renders the same bytes every time and different bytes for a different preparation", async () => {
    const bytes = await renderInterviewPdf(INTERVIEW, interviewPdfHr);
    expect(await renderInterviewPdf(INTERVIEW, interviewPdfHr)).toEqual(bytes);
    const other = await renderInterviewPdf({ ...INTERVIEW, heldOn: "2026-11-26" }, interviewPdfHr);
    expect(other).not.toEqual(bytes);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(document.getTitle()).toBe(interviewPdfHr.title);
    expect(document.getPageCount()).toBe(1);
    expect(createHash("sha256").update(bytes).digest("hex")).toMatchInlineSnapshot(
      `"d6f55447a6bacd6209061751512764f1568756383ac2a9825c67e7911b07eb45"`,
    );
  });

  it("carries the notice that the preparation is no accusation", () => {
    expect(interviewPdfHr.notice).toBe(
      "Ovo je priprema za razgovor, ne optužba ni disciplinski postupak.",
    );
  });

  it("goes on to more pages for a long preparation and draws what the font lacks as plain text", async () => {
    const many = {
      ...INTERVIEW,
      questions: Array.from({ length: 50 }, (_, index) => ({
        id: `c0300000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        paragraphRef: `p-${index}`,
        questionText: `„Pitanje ${index}” ${"riječ ".repeat(80)}${"x".repeat(200)}\nnovi redak 😀`,
      })),
    };
    const bytes = await renderInterviewPdf(many, interviewPdfHr);
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(document.getPageCount()).toBeGreaterThan(3);
    expect(await textOf(bytes)).toContain("%PDF");
  });

  it("has no field or label for an outcome, a grade, a sanction or a suspicion", () => {
    const labels = Object.values(interviewPdfHr).join(" ");
    expect(labels).not.toMatch(/ishod|ocjen|sankcij|sumnj|presud|kazn/iu);
  });
});
