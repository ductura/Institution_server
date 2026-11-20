// SRV-1110: the ZIP of the Merlin package and the service that builds it.
// The ZIP is read back with a small reader of stored entries, so the test
// checks the bytes it carries, not the builder's own lists. All names, texts
// and ids are invented.
import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  newNodeId,
  paragraphNode,
  textNode,
  type CanonicalDocument,
} from "../../../domain/index.ts";
import { merlinHr } from "../../../../locales/index.ts";
import type { MerlinPackageServiceDeps } from "./index.ts";
import type { SubmittedWorkSource } from "../../../database/index.ts";
import { sha256Hex } from "../files/index.ts";
import {
  buildMerlinRoster,
  merlinRosterCsv,
  type MerlinLabels,
  type MerlinRoster,
  type MerlinRosterRead,
} from "../roster/index.ts";

import {
  buildMerlinPackageZip,
  createMerlinPackageService,
  MERLIN_PACKAGE_CSV,
  MERLIN_PACKAGE_FINGERPRINTS,
} from "./index.ts";

const LABELS: MerlinLabels = { ...merlinHr };
const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const P = "00000000-0000-4000-8000-0000000000b1";
const KEY = "4b1e2c3d-0000-4000-8000-00000000aaa1";
const sid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

function body(text: string): string {
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
}
function student(n: number, familyName: string, givenName: string, revision: number | null) {
  return {
    studentId: sid(n),
    familyName,
    givenName,
    work:
      revision === null
        ? null
        : { documentId: `rad-${n}`, submitted: true, revision, body: body(`Izmišljeni rad ${n}`) },
  } satisfies SubmittedWorkSource;
}
const submission = (n: number, revision: number | null) => ({
  studentId: sid(n),
  submitted: revision !== null,
  revision,
  requestedMinute: revision === null ? null : "2026-12-20T21:14:00.000Z",
  afterDeadline: revision === null ? null : false,
});

async function roster(): Promise<MerlinRoster> {
  return buildMerlinRoster(
    [submission(1, 4), submission(2, null), submission(3, 2)],
    [
      student(1, "Šimić", "Ana", 4),
      student(2, "Babić", "Dora", null),
      student(3, "Anić", "Demo", 2),
    ],
    LABELS.exportLabels,
  );
}

/** The entries of a ZIP of stored entries, in order. */
function readZip(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: { name: string; data: Uint8Array }[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    expect(view.getUint16(at + 8, true)).toBe(0); // stored
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra;
    out.push({ name, data: bytes.subarray(start, start + size) });
    at = start + size;
  }
  return out;
}

describe("buildMerlinPackageZip", () => {
  it("carries the CSV, the PDF and DOCX of every submitted work and their fingerprints", async () => {
    const r = await roster();
    const zip = buildMerlinPackageZip(r, LABELS);
    const entries = readZip(zip.bytes);
    expect(entries.map((e) => e.name)).toEqual([
      MERLIN_PACKAGE_CSV,
      "anic-demo-00000000.pdf",
      "anic-demo-00000000.docx",
      "simic-ana-00000000.pdf",
      "simic-ana-00000000.docx",
      MERLIN_PACKAGE_FINGERPRINTS,
    ]);
    expect(zip.names).toEqual(entries.map((e) => e.name));
    const byName = new Map(entries.map((e) => [e.name, e.data]));
    // The CSV is the roster's, byte for byte.
    expect(Buffer.from(byName.get(MERLIN_PACKAGE_CSV)!).toString("utf8")).toBe(
      merlinRosterCsv(r.rows, LABELS),
    );
    expect(Buffer.from(byName.get("anic-demo-00000000.pdf")!).subarray(0, 5).toString()).toBe(
      "%PDF-",
    );
    expect(Buffer.from(byName.get("anic-demo-00000000.docx")!).subarray(0, 2).toString()).toBe(
      "PK",
    );
    // Every fingerprint the CSV names is that of the file in the ZIP.
    for (const row of r.rows.filter((x) => x.submitted)) {
      expect(sha256Hex(byName.get(row.pdfName!)!)).toBe(row.pdfSha256);
      expect(sha256Hex(byName.get(row.docxName!)!)).toBe(row.docxSha256);
    }
    // otisci.sha256 names every other file with its fingerprint, in order.
    const lines = Buffer.from(byName.get(MERLIN_PACKAGE_FINGERPRINTS)!).toString("utf8");
    expect(lines).toBe(
      entries
        .slice(0, -1)
        .map((e) => `${sha256Hex(e.data)}  ${e.name}\n`)
        .join(""),
    );
    expect(zip.sha256).toBe(sha256Hex(zip.bytes));
  });

  it("gives the same bytes for the same roster", async () => {
    expect(buildMerlinPackageZip(await roster(), LABELS).sha256).toBe(
      buildMerlinPackageZip(await roster(), LABELS).sha256,
    );
  });

  it("carries only the CSV and the fingerprints without a submission", () => {
    const zip = buildMerlinPackageZip({ rows: [], files: [], studentIds: [] }, LABELS);
    expect(readZip(zip.bytes).map((e) => e.name)).toEqual([
      MERLIN_PACKAGE_CSV,
      MERLIN_PACKAGE_FINGERPRINTS,
    ]);
  });

  it("throws when the roster and its files disagree", async () => {
    const r = await roster();
    const [first, ...rest] = r.files;
    const changed = { ...first!, bytes: new Uint8Array([...first!.bytes, 0]) };
    expect(() => buildMerlinPackageZip({ ...r, files: [changed, ...rest] }, LABELS)).toThrow();
    expect(() => buildMerlinPackageZip({ ...r, files: rest }, LABELS)).toThrow();
    const extra = { name: "drugi-rad-00000000.pdf", bytes: first!.bytes };
    expect(() => buildMerlinPackageZip({ ...r, files: [...r.files, extra] }, LABELS)).toThrow();
    expect(() =>
      buildMerlinPackageZip({ ...r, studentIds: r.studentIds.slice(1) }, LABELS),
    ).toThrow();
    const unsafe = { ...first!, name: "../izlaz.pdf" };
    expect(() => buildMerlinPackageZip({ ...r, files: [unsafe, ...rest] }, LABELS)).toThrow();
  });
});

type Packages = MerlinPackageServiceDeps["packages"];

function service(
  over: { packages?: Partial<Packages>; roster?: () => Promise<MerlinRosterRead> } = {},
) {
  const calls: string[] = [];
  const reported: unknown[] = [];
  const stored: { bytes: Uint8Array; sha256: string; studentIds: readonly string[] }[] = [];
  const packages: Packages = {
    request: async () => (
      calls.push("request"),
      { status: "requested", id: P, state: "queued", claimed: true }
    ),
    complete: async (_t, _a, _p, bytes, sha256, studentIds) => {
      calls.push("complete");
      stored.push({ bytes, sha256, studentIds });
      return {
        status: "written",
        package: {
          id: P,
          state: "ready",
          sha256,
          byteSize: bytes.byteLength,
          expiresAt: "2026-11-22T09:15:00.000Z",
        },
      };
    },
    fail: async (_t, _a, _p, code) => (
      calls.push(`fail:${code}`),
      {
        status: "written",
        package: { id: P, state: "failed", sha256: null, byteSize: null, expiresAt: null },
      }
    ),
    status: async () => (
      calls.push("status"),
      {
        status: "read",
        package: { id: P, state: "queued", sha256: null, byteSize: null, expiresAt: null },
      }
    ),
    download: async () => ({ status: "not_ready" }),
    ...over.packages,
  };
  const s = createMerlinPackageService({
    packages,
    roster:
      over.roster ??
      (async () => (
        calls.push("roster"),
        { status: "read", roster: await roster(), extensionReasons: [] }
      )),
    labels: LABELS,
  });
  const ask = () => s.request(TOKEN, A, KEY, (error) => reported.push(error));
  return { s: { request: ask }, calls, reported, stored };
}

describe("createMerlinPackageService", () => {
  it("builds a claimed package and stores the ZIP with its fingerprint", async () => {
    const { s, calls, stored } = service();
    expect(await s.request()).toEqual({ status: "accepted", id: P, state: "ready" });
    expect(calls).toEqual(["request", "roster", "complete"]);
    expect(stored[0]!.sha256).toBe(sha256Hex(stored[0]!.bytes));
    expect(readZip(stored[0]!.bytes)[0]!.name).toBe(MERLIN_PACKAGE_CSV);
    // Every student of the roster, also the one without a submission, in row order.
    expect(stored[0]!.studentIds).toEqual([sid(3), sid(2), sid(1)]);
  });

  it("answers a package another request holds without building it", async () => {
    const { s, calls } = service({
      packages: {
        request: async () => ({ status: "requested", id: P, state: "ready", claimed: false }),
      },
    });
    expect(await s.request()).toEqual({ status: "accepted", id: P, state: "ready" });
    expect(calls).toEqual([]);
  });

  it.each([
    { status: "unauthorized" },
    { status: "not_found" },
    { status: "invalid_input" },
  ] as const)("passes on a refused request (%o)", async (refusal) => {
    const { s, calls } = service({ packages: { request: async () => refusal } });
    expect(await s.request()).toEqual(refusal);
    expect(calls).toEqual([]);
  });

  it("records a build that throws as failed and reports it", async () => {
    const boom = new Error("izmisljena greska");
    const { s, calls, reported } = service({ roster: () => Promise.reject(boom) });
    expect(await s.request()).toEqual({ status: "accepted", id: P, state: "failed" });
    expect(calls).toEqual(["request", "fail:build_failed"]);
    expect(reported).toEqual([boom]);
  });

  it("records a roster the database refused as failed", async () => {
    const { s, calls } = service({ roster: async () => ({ status: "not_found" }) });
    expect(await s.request()).toEqual({ status: "accepted", id: P, state: "failed" });
    expect(calls).toEqual(["request", "fail:roster_refused"]);
  });

  it("a session that ended during the build is unauthorized, and the package stays queued", async () => {
    const { s, calls } = service({ roster: async () => ({ status: "unauthorized" }) });
    expect(await s.request()).toEqual({ status: "unauthorized" });
    expect(calls).toEqual(["request"]);
  });

  it("answers the current state when another request finished first", async () => {
    const { s, calls } = service({ packages: { complete: async () => ({ status: "not_ready" }) } });
    expect(await s.request()).toEqual({ status: "accepted", id: P, state: "queued" });
    expect(calls).toEqual(["request", "roster", "status"]);
  });

  it("a relation lost before the store is not_found", async () => {
    const { s } = service({ packages: { complete: async () => ({ status: "not_found" }) } });
    expect(await s.request()).toEqual({ status: "not_found" });
  });
});
