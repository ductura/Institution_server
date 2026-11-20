// The Merlin roster of one assignment (SRV-1109, Val 11, N-18, C-16, D-286):
// one row per student of the assignment, by surname (Croatian alphabet), then
// given name, then student id; a student without a name pair comes last. The
// columns are those of D-286: surname, given name, submitted, the minute of
// the submission, after the deadline (judged against the deadline in force,
// with an approved extension, as the submission recorded it), and the names
// of the student's files in the package with their SHA-256 fingerprints. A
// student without a submission has empty fingerprints. Nothing from the
// process summary, no reason and no private criterion is a column (D-286).
//
// The rows join two reads: the submissions of the assignment (minute, after
// the deadline, revision) and the documents (names, text). The two must agree
// on every student and on the submitted revision; if they do not, the roster
// throws and the route answers 503, never a roster whose file is not the
// submitted one.
import type { ExportLabels } from "../../export/index.ts";
import { compareHr, verifyVersionedDocumentSnapshot } from "../../../domain/index.ts";
import {
  fileBaseName,
  renderWorkFiles,
  sha256Hex,
  type SubmittedWorkSource,
  type WorkFiles,
} from "../files/index.ts";

export type MerlinRosterRow = {
  readonly familyName: string | null;
  readonly givenName: string | null;
  readonly submitted: boolean;
  /** The submission's request on a whole UTC minute (D-24); null without one. */
  readonly submittedMinute: string | null;
  readonly afterDeadline: boolean | null;
  readonly pdfName: string | null;
  readonly pdfSha256: string | null;
  readonly docxName: string | null;
  readonly docxSha256: string | null;
};

/** A row of the submissions read (teacher.submissions.get). */
export type RosterSubmission = {
  readonly studentId: string;
  readonly submitted: boolean;
  readonly revision: number | null;
  readonly requestedMinute: string | null;
  readonly afterDeadline: boolean | null;
};

/** One file of the package: the roster names it and the package carries its bytes. */
export type MerlinFile = { readonly name: string; readonly bytes: Uint8Array };

export type MerlinRoster = {
  readonly rows: readonly MerlinRosterRow[];
  readonly files: readonly MerlinFile[];
};

function byName(a: SubmittedWorkSource, b: SubmittedWorkSource): number {
  if ((a.familyName === null) !== (b.familyName === null)) return a.familyName === null ? 1 : -1;
  return (
    compareHr(a.familyName ?? "", b.familyName ?? "") ||
    compareHr(a.givenName ?? "", b.givenName ?? "") ||
    (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0)
  );
}

async function filesOf(
  student: SubmittedWorkSource,
  revision: number,
  labels: ExportLabels,
): Promise<WorkFiles> {
  const { work } = student;
  if (work === null || !work.submitted || work.revision !== revision) {
    throw new Error("submitted revision not readable");
  }
  const verified = await verifyVersionedDocumentSnapshot(new TextEncoder().encode(work.body));
  if (!verified.ok) throw new Error("submitted document invalid");
  const cover =
    student.givenName === null ? "" : `${student.givenName} ${student.familyName ?? ""}`;
  return renderWorkFiles({ document: verified.document, student: cover, labels });
}

/** The rows by surname and the files they name, or throws when the two reads disagree. */
export async function buildMerlinRoster(
  submissions: readonly RosterSubmission[],
  students: readonly SubmittedWorkSource[],
  labels: ExportLabels,
): Promise<MerlinRoster> {
  const byStudent = new Map(submissions.map((s) => [s.studentId, s]));
  if (byStudent.size !== submissions.length || byStudent.size !== students.length) {
    throw new Error("roster reads disagree");
  }
  const rows: MerlinRosterRow[] = [];
  const files: MerlinFile[] = [];
  for (const student of [...students].sort(byName)) {
    const submission = byStudent.get(student.studentId);
    if (submission === undefined) throw new Error("roster reads disagree");
    const names = { familyName: student.familyName, givenName: student.givenName };
    if (!submission.submitted || submission.revision === null) {
      rows.push({
        ...names,
        submitted: false,
        submittedMinute: null,
        afterDeadline: null,
        pdfName: null,
        pdfSha256: null,
        docxName: null,
        docxSha256: null,
      });
      continue;
    }
    const rendered = await filesOf(student, submission.revision, labels);
    const base = fileBaseName(student.familyName, student.givenName, student.studentId);
    const pdf = { name: `${base}.pdf`, bytes: rendered.pdf };
    const docx = { name: `${base}.docx`, bytes: rendered.docx };
    files.push(pdf, docx);
    rows.push({
      ...names,
      submitted: true,
      submittedMinute: submission.requestedMinute,
      afterDeadline: submission.afterDeadline,
      pdfName: pdf.name,
      pdfSha256: sha256Hex(pdf.bytes),
      docxName: docx.name,
      docxSha256: sha256Hex(docx.bytes),
    });
  }
  return { rows, files };
}
