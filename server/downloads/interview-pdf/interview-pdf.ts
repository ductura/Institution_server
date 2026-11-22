import fontkit from "@pdf-lib/fontkit";
import { PageSizes, PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { RECEIPT_FONT_BASE64 } from "../receipt-pdf/index.ts";

export type InterviewPdfLabels = Readonly<{
  title: string;
  notice: string;
  work: string;
  invitedAt: string;
  appointment: string;
  noAppointment: string;
  consultationSlot: string;
  place: string;
  at: string;
  heldOn: string;
  notHeld: string;
  questions: string;
  noQuestions: string;
  generalQuestion: string;
  paragraph: string;
  explanations: string;
  noExplanations: string;
  generalExplanation: string;
  aboutQuestion: string;
  page: string;
  pageOf: string;
}>;

/** What the student reads of the preparation, as the interview route answers it. */
export type InterviewPdfInput = Readonly<{
  documentId: string;
  invitedAt: string;
  questions: readonly Readonly<{
    id: string;
    paragraphRef: string | null;
    questionText: string;
  }>[];
  explanations: readonly Readonly<{ questionId: string | null; text: string }>[];
  appointment:
    | Readonly<{ consultationSlotId: string; startsAt: string }>
    | Readonly<{ place: string; at: string }>
    | null;
  heldOn: string | null;
}>;

const MARGIN = 54;
const TOP = 790;
const BOTTOM = 70;
const WIDTH = PageSizes.A4[0] - 2 * MARGIN;
const GRAPHITE = rgb(0.12, 0.12, 0.12);
const SECONDARY = rgb(0.3, 0.3, 0.3);
const FONT_BYTES = Buffer.from(RECEIPT_FONT_BASE64, "base64");
// The embedded font is a subset: typographic marks it lacks are written as plain ones.
const PLAIN: Readonly<Record<string, string>> = {
  "„": '"',
  "”": '"',
  "“": '"',
  "’": "'",
  "‘": "'",
  "–": "-",
  "—": "-",
  "·": "-",
  "…": "...",
  " ": " ",
};

/** One line of text the font can draw: no control characters, no glyph it lacks. */
function drawable(value: string, font: PDFFont): string {
  const known = new Set(font.getCharacterSet());
  let result = "";
  for (const char of value) {
    const mapped = PLAIN[char] ?? char;
    for (const part of mapped) {
      const code = part.codePointAt(0)!;
      result += code < 0x20 || code === 0x7f || !known.has(code) ? "?" : part;
    }
  }
  return result;
}

/** `2026-11-22T10:00:00.000Z` as `2026-11-22 10:00 UTC`: the same text for the same instant. */
const instant = (value: string): string => `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;

type Line = { text: string; size: number; gap: number; color: typeof GRAPHITE; indent: number };

/** Render the same bytes for the same preparation and labels. */
export async function renderInterviewPdf(
  interview: InterviewPdfInput,
  labels: InterviewPdfLabels,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit);
  pdf.setTitle(labels.title);
  const font = await pdf.embedFont(FONT_BYTES, { subset: true });

  const lines: Line[] = [];
  const add = (
    value: string,
    size = 11,
    options: { gap?: number; color?: typeof GRAPHITE; indent?: number } = {},
  ) => {
    const indent = options.indent ?? 0;
    for (const paragraph of drawable(value, font).split(/\r\n|\r|\n/u)) {
      const words = paragraph.split(" ");
      let current = "";
      let first = true;
      const flush = () => {
        lines.push({
          text: current,
          size,
          gap: first ? (options.gap ?? 0) : 0,
          color: options.color ?? GRAPHITE,
          indent,
        });
        first = false;
        current = "";
      };
      for (const word of words) {
        let rest = word;
        const fits = (text: string) => font.widthOfTextAtSize(text, size) <= WIDTH - indent;
        if (current !== "" && !fits(`${current} ${rest}`)) flush();
        // A word wider than a line is broken where the line ends.
        while (!fits(current === "" ? rest : `${current} ${rest}`) && rest.length > 1) {
          // Binary search for the longest prefix that fits: measuring (shaping) each
          // candidate one by one made a long unbroken word take seconds.
          let low = 1;
          let high = rest.length - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (fits(rest.slice(0, middle))) low = middle;
            else high = middle - 1;
          }
          const cut = low;
          current = current === "" ? rest.slice(0, cut) : `${current} ${rest.slice(0, cut)}`;
          rest = rest.slice(cut);
          flush();
        }
        current = current === "" ? rest : `${current} ${rest}`;
      }
      flush();
    }
  };

  add(labels.title, 24);
  add(labels.notice, 12, { gap: 8, color: SECONDARY });
  add(`${labels.work}: ${interview.documentId}`, 11, { gap: 14 });
  add(`${labels.invitedAt}: ${instant(interview.invitedAt)}`, 11, { gap: 4 });
  add(labels.appointment, 15, { gap: 18 });
  const { appointment } = interview;
  if (appointment === null) add(labels.noAppointment, 11, { gap: 4, color: SECONDARY });
  else if ("consultationSlotId" in appointment) {
    add(`${labels.consultationSlot}: ${instant(appointment.startsAt)}`, 11, { gap: 4 });
  } else {
    add(`${labels.place}: ${appointment.place}`, 11, { gap: 4 });
    add(`${labels.at}: ${instant(appointment.at)}`, 11, { gap: 2 });
  }
  add(interview.heldOn === null ? labels.notHeld : `${labels.heldOn}: ${interview.heldOn}`, 11, {
    gap: 6,
    color: interview.heldOn === null ? SECONDARY : GRAPHITE,
  });

  add(labels.questions, 15, { gap: 18 });
  if (interview.questions.length === 0) add(labels.noQuestions, 11, { gap: 4, color: SECONDARY });
  interview.questions.forEach((question, index) => {
    const about =
      question.paragraphRef === null
        ? labels.generalQuestion
        : `${labels.paragraph}: ${question.paragraphRef}`;
    add(`${index + 1}. ${about}`, 10, { gap: 10, color: SECONDARY });
    add(question.questionText, 11, { gap: 2, indent: 14 });
  });

  add(labels.explanations, 15, { gap: 18 });
  if (interview.explanations.length === 0) {
    add(labels.noExplanations, 11, { gap: 4, color: SECONDARY });
  }
  interview.explanations.forEach((explanation) => {
    const number = interview.questions.findIndex((q) => q.id === explanation.questionId);
    const about =
      explanation.questionId === null || number === -1
        ? labels.generalExplanation
        : `${labels.aboutQuestion} ${number + 1}`;
    add(about, 10, { gap: 10, color: SECONDARY });
    add(explanation.text, 11, { gap: 2, indent: 14 });
  });

  const pages: PDFPage[] = [];
  let y = TOP;
  for (const line of lines) {
    const height = line.size * 1.35;
    if (pages.length === 0 || y - line.gap - height < BOTTOM) {
      pages.push(pdf.addPage(PageSizes.A4));
      y = TOP;
    } else y -= line.gap;
    y -= height;
    if (line.text !== "") {
      pages.at(-1)!.drawText(line.text, {
        x: MARGIN + line.indent,
        y,
        size: line.size,
        font,
        color: line.color,
      });
    }
  }
  pages.forEach((page, index) => {
    page.drawText(drawable(`${labels.page} ${index + 1} ${labels.pageOf} ${pages.length}`, font), {
      x: MARGIN,
      y: 40,
      size: 9,
      font,
      color: SECONDARY,
    });
  });

  return pdf.save();
}
