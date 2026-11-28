// SRV-1308 acceptance at the level of functions: the same contents give the
// same ZIP bytes (1); the package of one person holds nothing of another
// (3, two invented students); the job stores the package before the export
// is ready, keeps only the token's SHA-256, and one failing export does not
// stop the others. Every value is invented (test-support/portable-record).
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LABELS,
  ORIGIN,
  PAYLOAD,
  sourceOf,
  STUDENT_A,
  STUDENT_B,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import { renderReceiptPdf } from "../../downloads/index.ts";

import {
  ACCESS_LOG_FILE,
  buildStudentDataExportPackage,
  MANIFEST_FILE,
  NOTES_FILE,
  runStudentDataExportPass,
  STUDENT_DATA_EXPORT_FORMAT,
  studentDataExportTokenHash,
  type PackageContents,
  type StudentDataExportJobPort,
  type StudentDataExportLink,
  type StudentDataExportStorage,
} from "./index.ts";

const decoder = new TextDecoder();
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const ASSIGNMENT = PAYLOAD.assignmentId;
/** An invented confirmation code of A's signed submission. */
const CODE = "DK7M-4Q9P-X2HT-R8VN";
const VESNA = { givenName: "Vesna", familyName: "Izmisljena" };

/** A row of the access log read, under the database's own column names. */
function logRow(id: string, at: string, surface: string): Record<string, unknown> {
  return Object.fromEntries([
    ["entry_id", id],
    ["opened_at", new Date(at)],
    ["surface", surface],
    ["reader_role", "teacher"],
    ["reader_given_name", VESNA.givenName],
    ["reader_family_name", VESNA.familyName],
  ]);
}

async function contentsOfA(): Promise<PackageContents> {
  const source = await sourceOf();
  return {
    submissions: [
      {
        submissionId: SUBMISSION_ID,
        assignmentId: ASSIGNMENT,
        revision: PAYLOAD.revision,
        requestedAt: "2026-11-20T10:58:00.123Z",
        body: TEXT,
        receipt: {
          payload: source.receiptPayload,
          payloadDigestSha256: source.payloadDigestSha256,
          signature: source.signature,
        },
        confirmationCode: CODE,
      },
      {
        submissionId: "0b8a6f3e-2d1c-4e5f-9a7b-6c5d4e3f2a1b",
        assignmentId: ASSIGNMENT,
        revision: 3,
        requestedAt: "2026-11-21T09:00:00.000Z",
        body: "Izmisljeni drugi predani tekst studentice A.",
        receipt: null,
        confirmationCode: null,
      },
    ],
    notes: [
      {
        noteId: "6f5e4d3c-2b1a-4c9d-8e7f-0a1b2c3d4e5f",
        assignmentId: ASSIGNMENT,
        createdAt: "2026-11-20T11:00:00.000Z",
        text: "Izmisljena biljeska studentice A.",
      },
    ],
    accessLog: [
      logRow("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "2026-11-19T12:00:00.000Z", "live_view"),
      logRow("2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", "2026-11-20T08:05:00.000Z", "process_summary"),
    ],
  };
}

const CONTENTS_B: PackageContents = {
  submissions: [
    {
      submissionId: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
      assignmentId: ASSIGNMENT,
      revision: 2,
      requestedAt: "2026-11-20T10:00:00.000Z",
      body: "Izmisljeni predani tekst studenta B.",
      receipt: null,
      confirmationCode: null,
    },
  ],
  notes: [
    {
      noteId: "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d",
      assignmentId: ASSIGNMENT,
      createdAt: "2026-11-20T12:00:00.000Z",
      text: "Izmisljena biljeska studenta B.",
    },
  ],
  accessLog: [],
};

describe("buildStudentDataExportPackage", () => {
  it("gives the same bytes for the same contents, in any input order (acceptance 1)", async () => {
    const a = await contentsOfA();
    const first = await buildStudentDataExportPackage(a, ORIGIN, LABELS);
    const reordered = await buildStudentDataExportPackage(
      {
        submissions: [...a.submissions].reverse(),
        notes: [...a.notes].reverse(),
        accessLog: [...a.accessLog].reverse(),
      },
      ORIGIN,
      LABELS,
    );
    if (first.status !== "built" || reordered.status !== "built") throw new Error("not built");
    expect(Buffer.from(reordered.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    expect(first.sha256).toBe(sha(first.bytes));
    const other = await buildStudentDataExportPackage(CONTENTS_B, ORIGIN, LABELS);
    if (other.status !== "built") throw new Error("not built");
    expect(other.sha256).not.toBe(first.sha256);
  });

  it("holds the texts, the receipt PDF, the notes and the access log by day, with a manifest", async () => {
    const built = await buildStudentDataExportPackage(await contentsOfA(), ORIGIN, LABELS);
    if (built.status !== "built") throw new Error("not built");
    const files = unzipStored(built.bytes);
    expect([...files.keys()]).toEqual(built.names);
    expect(built.names).toEqual(
      [
        MANIFEST_FILE,
        NOTES_FILE,
        ACCESS_LOG_FILE,
        `predaje/001-${SUBMISSION_ID}/potvrda-predaje.pdf`,
        `predaje/001-${SUBMISSION_ID}/predani-tekst.json`,
        "predaje/002-0b8a6f3e-2d1c-4e5f-9a7b-6c5d4e3f2a1b/predani-tekst.txt",
      ].sort((x, y) => (x === MANIFEST_FILE ? -1 : y === MANIFEST_FILE ? 1 : x < y ? -1 : 1)),
    );
    expect(decoder.decode(files.get(`predaje/001-${SUBMISSION_ID}/predani-tekst.json`))).toBe(TEXT);
    expect(
      decoder.decode(files.get(`predaje/001-${SUBMISSION_ID}/potvrda-predaje.pdf`)!.slice(0, 5)),
    ).toBe("%PDF-");
    const notes = JSON.parse(decoder.decode(files.get(NOTES_FILE))) as {
      notes: { text: string }[];
    };
    expect(notes.notes.map((n) => n.text)).toEqual(["Izmisljena biljeska studentice A."]);
    const log = JSON.parse(decoder.decode(files.get(ACCESS_LOG_FILE))) as {
      days: { date: string; openings: { surface: string; reader: unknown }[] }[];
    };
    expect(log.days.map((d) => d.date)).toEqual(["2026-11-20", "2026-11-19"]);
    expect(log.days[0]!.openings[0]).toMatchObject({ surface: "process_summary", reader: VESNA });
    const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
      format: string;
      submissions: { receipt: string | null }[];
      files: { name: string; sha256: string }[];
    };
    expect(manifest.format).toBe(STUDENT_DATA_EXPORT_FORMAT);
    expect(manifest.submissions.map((s) => s.receipt === null)).toEqual([false, true]);
    for (const file of manifest.files) expect(sha(files.get(file.name)!)).toBe(file.sha256);
  });

  it("carries the bound confirmation code as the receipt route's PDF does (Dizajn 1.1)", async () => {
    const a = await contentsOfA();
    const built = await buildStudentDataExportPackage(a, ORIGIN, LABELS);
    if (built.status !== "built") throw new Error("not built");
    const pdf = Buffer.from(
      unzipStored(built.bytes).get(`predaje/001-${SUBMISSION_ID}/potvrda-predaje.pdf`)!,
    );
    const stored = a.submissions[0]!.receipt!;
    const receipt = {
      payload: JSON.parse(stored.payload) as unknown,
      payloadDigestSha256: stored.payloadDigestSha256,
      signature: stored.signature,
    } as Parameters<typeof renderReceiptPdf>[0];
    // student.receipt-pdf.get: renderReceiptPdf(receipt, origin, receiptPdfHr, code).
    expect(pdf.equals(Buffer.from(await renderReceiptPdf(receipt, ORIGIN, LABELS, CODE)))).toBe(
      true,
    );
    expect(pdf.equals(Buffer.from(await renderReceiptPdf(receipt, ORIGIN, LABELS)))).toBe(false);
    // Another code gives other bytes: the PDF is bound to the code it was given.
    const other = await buildStudentDataExportPackage(
      {
        ...a,
        submissions: [{ ...a.submissions[0]!, confirmationCode: "0000-1111-2222-3333" }],
      },
      ORIGIN,
      LABELS,
    );
    if (other.status !== "built") throw new Error("not built");
    expect(
      pdf.equals(
        Buffer.from(
          unzipStored(other.bytes).get(`predaje/001-${SUBMISSION_ID}/potvrda-predaje.pdf`)!,
        ),
      ),
    ).toBe(false);
  });

  it("holds nothing of another student (acceptance 3)", async () => {
    const built = await buildStudentDataExportPackage(await contentsOfA(), ORIGIN, LABELS);
    if (built.status !== "built") throw new Error("not built");
    const all = [...unzipStored(built.bytes).values()].map((bytes) =>
      Buffer.from(bytes).toString("latin1"),
    );
    for (const value of [
      STUDENT_B.id,
      STUDENT_B.name,
      STUDENT_B.email,
      "studenta B",
      CONTENTS_B.submissions[0]!.submissionId,
      CONTENTS_B.notes[0]!.noteId,
    ]) {
      expect(all.some((text) => text.includes(value))).toBe(false);
    }
    expect(all.some((text) => text.includes(STUDENT_A.email))).toBe(false);
  });

  it("refuses a receipt of another submission and an access log row it cannot read", async () => {
    const a = await contentsOfA();
    const swapped = {
      ...a,
      submissions: [
        { ...a.submissions[0]!, submissionId: CONTENTS_B.submissions[0]!.submissionId },
      ],
    };
    expect(await buildStudentDataExportPackage(swapped, ORIGIN, LABELS)).toEqual({
      status: "refused",
      reason: "receipt_malformed",
    });
    const badLog = {
      ...a,
      accessLog: [logRow("nije-uuid", "2026-11-19T12:00:00.000Z", "live_view")],
    };
    expect(await buildStudentDataExportPackage(badLog, ORIGIN, LABELS)).toEqual({
      status: "refused",
      reason: "access_log_malformed",
    });
  });
});

const EXPORT_A = "11111111-1111-4111-8111-111111111111";
const EXPORT_B = "22222222-2222-4222-8222-222222222222";

function memoryStorage(): StudentDataExportStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, put: async (id, bytes) => void files.set(id, bytes) };
}

function port(
  contents: Map<string, PackageContents>,
  overrides: Partial<StudentDataExportJobPort> = {},
) {
  const marked: { exportId: string; hash: string; storedFirst: boolean }[] = [];
  let storage: ReturnType<typeof memoryStorage> | undefined;
  const exports: StudentDataExportJobPort = {
    toPrepare: async () => ({
      status: "ok",
      jobs: [...contents.keys()].map((exportId) => ({ exportId, jobRef: "Posao 1/2026" })),
    }),
    contents: async (id) => {
      const found = contents.get(id);
      return found ? { status: "ok", contents: found } : { status: "unavailable" };
    },
    markReady: async (exportId, hash) => {
      marked.push({
        exportId,
        hash: Buffer.from(hash).toString("hex"),
        storedFirst: storage!.files.has(exportId),
      });
      return { status: "ok", expiresAt: "2026-11-22T10:00:00.000Z" };
    },
    expire: async () => ({ status: "ok", expired: 1 }),
    ...overrides,
  };
  return { exports, marked, use: (s: ReturnType<typeof memoryStorage>) => void (storage = s) };
}

describe("runStudentDataExportPass", () => {
  it("stores each package before ready, keeps only the token's hash and delivers the token", async () => {
    const storage = memoryStorage();
    const { exports, marked, use } = port(
      new Map([
        [EXPORT_A, await contentsOfA()],
        [EXPORT_B, CONTENTS_B],
      ]),
    );
    use(storage);
    const delivered: StudentDataExportLink[] = [];
    let n = 0;
    const pass = await runStudentDataExportPass({
      exports,
      storage,
      deliver: async (link) => void delivered.push(link),
      origin: ORIGIN,
      labels: LABELS,
      randomToken: () => new Uint8Array(32).fill(++n),
    });
    expect(pass).toEqual({ ready: 2, expired: 1, failures: [] });
    // The hash the database keeps: SHA-256 of the token's UTF-8 bytes, as app.consume_student_data_export expects.
    expect(Buffer.from(studentDataExportTokenHash("abc")).toString("hex")).toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
    expect(marked.every((m) => m.storedFirst)).toBe(true);
    expect(delivered.map((d) => d.exportId)).toEqual([EXPORT_A, EXPORT_B]);
    for (const [i, link] of delivered.entries()) {
      expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(marked[i]!.hash).toBe(
        Buffer.from(studentDataExportTokenHash(link.token)).toString("hex"),
      );
      expect(marked[i]!.hash).not.toContain(Buffer.from(link.token).toString("hex"));
    }
    const b = unzipStored(storage.files.get(EXPORT_B)!);
    const textB = [...b.values()].map((v) => Buffer.from(v).toString("latin1")).join("\n");
    expect(textB).not.toContain("studentice A");
    expect(textB).not.toContain(SUBMISSION_ID);
  });

  it("goes on after one export fails and reports closed reasons only", async () => {
    const storage = memoryStorage();
    const { exports, use } = port(
      new Map([
        [EXPORT_A, await contentsOfA()],
        [EXPORT_B, CONTENTS_B],
      ]),
      {
        markReady: async (exportId) =>
          exportId === EXPORT_A
            ? { status: "conflict" }
            : { status: "ok", expiresAt: "2026-11-22T10:00:00.000Z" },
        expire: async () => ({ status: "unavailable" }),
      },
    );
    use(storage);
    const delivered: string[] = [];
    const pass = await runStudentDataExportPass({
      exports,
      storage,
      deliver: async (link) => void delivered.push(link.exportId),
      origin: ORIGIN,
      labels: LABELS,
    });
    expect(pass).toEqual({
      ready: 1,
      expired: 0,
      failures: ["mark_conflict", "expire_unavailable"],
    });
    expect(delivered).toEqual([EXPORT_B]);
  });

  it("never marks ready a package it could not store", async () => {
    const { exports, marked, use } = port(new Map([[EXPORT_B, CONTENTS_B]]));
    const storage = { ...memoryStorage(), put: async () => Promise.reject(new Error("disk")) };
    use(memoryStorage());
    const pass = await runStudentDataExportPass({
      exports,
      storage,
      deliver: async () => undefined,
      origin: ORIGIN,
      labels: LABELS,
    });
    expect(pass.failures).toEqual(["storage_failed"]);
    expect(marked).toEqual([]);
  });
});
