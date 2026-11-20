// SRV-1109: the Merlin roster, its CSV and the read behind both routes. All
// names, texts and ids are invented.
import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  newNodeId,
  paragraphNode,
  textNode,
  type CanonicalDocument,
} from "../../../domain/index.ts";
import { merlinHr } from "../../../../locales/index.ts";
import type { SubmittedWorkSource } from "../../../database/index.ts";
import { sha256Hex } from "../files/index.ts";

import {
  buildMerlinRoster,
  createMerlinRosterReader,
  merlinRosterCsv,
  type MerlinLabels,
  type MerlinRosterDeps,
  type RosterSubmission,
} from "./index.ts";

const LABELS: MerlinLabels = { ...merlinHr };
const MERLIN_EXPORT_LABELS = LABELS.exportLabels;
const MERLIN_CSV_HEADER = LABELS.csvHeader;
const A = "00000000-0000-4000-8000-0000000000a1";
const sid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const body = (text: string): string => {
  const doc: CanonicalDocument = {
    schemaVersion: 1,
    nodes: [
      paragraphNode(
        newNodeId(() => "00000000-0000-4000-8000-000000000001"),
        [textNode(text)],
      ),
    ],
  };
  return canonicalizeJcs(doc);
};

function student(
  n: number,
  familyName: string | null,
  givenName: string | null,
  revision: number | null,
): SubmittedWorkSource {
  return {
    studentId: sid(n),
    familyName,
    givenName,
    work:
      revision === null
        ? null
        : { documentId: `rad-${n}`, submitted: true, revision, body: body(`Izmišljeni rad ${n}`) },
  };
}
const submitted = (
  n: number,
  revision: number,
  afterDeadline = false,
): RosterSubmission & { documentId: string | null } => ({
  studentId: sid(n),
  documentId: `rad-${n}`,
  submitted: true,
  revision,
  requestedMinute: "2026-12-20T21:14:00.000Z",
  afterDeadline,
});
const open = (n: number): RosterSubmission & { documentId: string | null } => ({
  studentId: sid(n),
  documentId: null,
  submitted: false,
  revision: null,
  requestedMinute: null,
  afterDeadline: null,
});

const STUDENTS = [
  student(1, "Šimić", "Ana", 4),
  student(2, "Cvitan", "Iva", null),
  student(3, null, null, 2),
  student(4, "Čulić", "Ema", 3),
  student(5, "Sarić", "Bruno", 5),
  student(6, "Čulić", "Ante", null),
];
const SUBMISSIONS = [
  submitted(1, 4),
  open(2),
  submitted(3, 2, true),
  submitted(4, 3),
  submitted(5, 5),
  open(6),
];

describe("buildMerlinRoster", () => {
  it("orders by surname in the Croatian alphabet, then given name; no name pair last", async () => {
    const { rows } = await buildMerlinRoster(SUBMISSIONS, STUDENTS, MERLIN_EXPORT_LABELS);
    expect(rows.map((r) => [r.familyName, r.givenName])).toEqual([
      ["Cvitan", "Iva"],
      ["Čulić", "Ante"],
      ["Čulić", "Ema"],
      ["Sarić", "Bruno"],
      ["Šimić", "Ana"],
      [null, null],
    ]);
  });

  it("gives a student without a submission empty names and fingerprints", async () => {
    const { rows } = await buildMerlinRoster(SUBMISSIONS, STUDENTS, MERLIN_EXPORT_LABELS);
    expect(rows[0]).toEqual({
      familyName: "Cvitan",
      givenName: "Iva",
      submitted: false,
      submittedMinute: null,
      afterDeadline: null,
      pdfName: null,
      pdfSha256: null,
      docxName: null,
      docxSha256: null,
    });
  });

  it("names each file of the package and its fingerprint is of its bytes", async () => {
    const { rows, files } = await buildMerlinRoster(SUBMISSIONS, STUDENTS, MERLIN_EXPORT_LABELS);
    const byName = new Map(files.map((f) => [f.name, f.bytes]));
    const named = rows.filter((r) => r.submitted);
    expect(files).toHaveLength(named.length * 2);
    for (const row of named) {
      expect(sha256Hex(byName.get(row.pdfName!)!)).toBe(row.pdfSha256);
      expect(sha256Hex(byName.get(row.docxName!)!)).toBe(row.docxSha256);
    }
    expect(rows.find((r) => r.familyName === "Šimić")).toMatchObject({
      pdfName: "simic-ana-00000000.pdf",
      docxName: "simic-ana-00000000.docx",
      submittedMinute: "2026-12-20T21:14:00.000Z",
      afterDeadline: false,
    });
    expect(rows.at(-1)).toMatchObject({ pdfName: "student-00000000.pdf", afterDeadline: true });
    // Distinct documents, distinct fingerprints.
    expect(new Set(named.map((r) => r.pdfSha256)).size).toBe(named.length);
  });

  it("gives two students who would share a file name the whole id, so a name names one file", async () => {
    const twins = [
      student(1, null, null, 1),
      student(2, null, null, 1),
      student(3, "Anić", "Demo", 1),
    ];
    const { rows, files } = await buildMerlinRoster(
      [submitted(1, 1), submitted(2, 1), submitted(3, 1)],
      twins,
      MERLIN_EXPORT_LABELS,
    );
    expect(rows.map((r) => r.pdfName)).toEqual([
      "anic-demo-00000000.pdf",
      "student-00000000000040008000000000000001.pdf",
      "student-00000000000040008000000000000002.pdf",
    ]);
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
  });

  it("has only the columns of D-286 and the files: no summary, reason or criterion", async () => {
    const { rows } = await buildMerlinRoster(SUBMISSIONS, STUDENTS, MERLIN_EXPORT_LABELS);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(
        [
          "afterDeadline",
          "docxName",
          "docxSha256",
          "familyName",
          "givenName",
          "pdfName",
          "pdfSha256",
          "submitted",
          "submittedMinute",
        ].sort(),
      );
    }
  });

  it.each([
    ["a student missing from the documents", SUBMISSIONS, STUDENTS.slice(1)],
    ["a student missing from the submissions", SUBMISSIONS.slice(1), STUDENTS],
    ["another submitted revision", [submitted(1, 5), ...SUBMISSIONS.slice(1)], STUDENTS],
    ["a submission without its document", [...SUBMISSIONS.slice(0, 5), submitted(6, 1)], STUDENTS],
    [
      "a document that is not a valid snapshot",
      SUBMISSIONS,
      [
        { ...STUDENTS[0]!, work: { ...STUDENTS[0]!.work!, body: '{"schemaVersion":1}' } },
        ...STUDENTS.slice(1),
      ],
    ],
  ])("throws on %s, never a partial roster", async (_, submissions, students) => {
    await expect(buildMerlinRoster(submissions, students, MERLIN_EXPORT_LABELS)).rejects.toThrow();
  });
});

describe("merlinRosterCsv", () => {
  it("has the same rows and columns as the JSON, with a Croatian header", async () => {
    const { rows } = await buildMerlinRoster(SUBMISSIONS, STUDENTS, MERLIN_EXPORT_LABELS);
    const csv = merlinRosterCsv(rows, LABELS);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    const lines = csv.slice(1, -2).split("\r\n");
    expect(lines[0]).toBe(MERLIN_CSV_HEADER.join(","));
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1]).toBe("Cvitan,Iva,ne,,,,,,");
    const simic = rows.find((r) => r.familyName === "Šimić")!;
    expect(lines[5]).toBe(
      [
        "Šimić",
        "Ana",
        "da",
        "2026-12-20T21:14:00.000Z",
        "ne",
        simic.pdfName,
        simic.pdfSha256,
        simic.docxName,
        simic.docxSha256,
      ].join(","),
    );
  });

  it("quotes a separator and neutralises a formula", () => {
    const row = {
      familyName: "=HYPERLINK(1)",
      givenName: 'Ana, "Mala"',
      submitted: false,
      submittedMinute: null,
      afterDeadline: null,
      pdfName: null,
      pdfSha256: null,
      docxName: null,
      docxSha256: null,
    };
    expect(merlinRosterCsv([row], LABELS).split("\r\n")[1]).toBe(
      `'=HYPERLINK(1),"Ana, ""Mala""",ne,,,,,,`,
    );
  });
});

describe("createMerlinRosterReader", () => {
  const extension = (reasonId: string | null, studentId: string | null) => ({
    id: "00000000-0000-4000-8000-0000000000f1",
    scope: studentId === null ? "all" : "one",
    studentId,
    previousDueAt: "2026-12-20T23:00:00.000Z",
    dueAt: "2026-12-27T23:00:00.000Z",
    reasonId,
    createdBy: "00000000-0000-4000-8000-0000000000c1",
    createdAt: "2026-11-21T09:15:00.000Z",
  });

  function deps(over: Partial<MerlinRosterDeps> = {}) {
    const calls: string[] = [];
    const base: Omit<MerlinRosterDeps, "labels"> = {
      extensions: async () => (
        calls.push("extensions"),
        {
          status: "read",
          extensions: [extension("justified", sid(1)), extension(null, null)],
        } as never
      ),
      submissions: async () => (
        calls.push("submissions"),
        { status: "ok", submissions: new Map([[A, SUBMISSIONS]]) }
      ),
      works: async () => (calls.push("works"), { status: "read", students: STUDENTS }),
    };
    return { calls, read: createMerlinRosterReader({ ...base, labels: LABELS, ...over }) };
  }

  it("answers the rows and only the caller's own extension reasons", async () => {
    const { read } = deps();
    const result = await read("izmisljeni-token", A);
    if (result.status !== "read") throw new Error(result.status);
    expect(result.roster.rows).toHaveLength(6);
    expect(result.extensionReasons).toEqual([
      { studentId: sid(1), dueAt: "2026-12-27T23:00:00.000Z", reasonId: "justified" },
    ]);
  });

  it("is not_found for another course, before it reads a submission or a text", async () => {
    const { read, calls } = deps({
      extensions: async () => ({ status: "not_found" }),
    });
    expect(await read("izmisljeni-token", A)).toEqual({ status: "not_found" });
    const second = deps({ extensions: async () => ({ status: "unauthorized" }) });
    expect(await second.read("izmisljeni-token", A)).toEqual({ status: "unauthorized" });
    expect(calls).toEqual([]);
    expect(second.calls).toEqual([]);
  });

  it("throws when the submissions cannot be read", async () => {
    const { read } = deps({
      submissions: async () => ({ status: "unavailable", reason: "rows_malformed" }),
    });
    await expect(read("izmisljeni-token", A)).rejects.toThrow();
  });
});
