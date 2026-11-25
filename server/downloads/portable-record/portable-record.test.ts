// SRV-1312 acceptance 2 and 3 at the level of functions: the same submission
// gives the same ZIP, the record verifies offline, one changed byte of the
// text fails, and the QR of the PDF carries only the submission id and the
// SHA-256 of the text in the fragment, never a name, an e-mail or the text.
// Every value is invented (portable-record.fixture.ts).
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { encode } from "uqr";
import { describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  evidenceLogLeafHash,
  evidenceLogRoot,
  orderEvidenceLogEntries,
} from "../../domain/index.ts";
import { renderReceiptPdf } from "../receipt-pdf/index.ts";

import {
  buildPortableRecord,
  PENDING_DAILY_ROOT,
  PORTABLE_RECORD_FILES as FILES,
  submissionLogEntry,
  verifyPortableRecord,
  type DailyRootCheck,
  type PortableDailyRootSource,
  type PortableLogEntry,
  type PortableRecordSource,
} from "./index.ts";
import {
  LABELS,
  ORIGIN,
  PAYLOAD,
  RECEIPT_KEY,
  SENTENCE,
  sourceOf,
  STUDENT_A,
  STUDENT_B,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Invented other entries of the same day, around the receipt's own. */
function otherEntries(count: number): PortableLogEntry[] {
  return Array.from({ length: count }, (_, n) => ({
    receiptId: `izmisljena-potvrda-${n}`,
    acceptedAt: `2026-11-20T0${n % 10}:00:00.000Z`,
    digest: hex(encoder.encode(String(n).padStart(32, "x"))),
  }));
}

async function rootOf(entries: readonly PortableLogEntry[]): Promise<string> {
  const ordered = orderEvidenceLogEntries(entries.map((e) => ({ ...e })));
  const leaves = await Promise.all(
    ordered.map((e) => evidenceLogLeafHash(Uint8Array.from(Buffer.from(e.digest, "hex")))),
  );
  return hex(await evidenceLogRoot(leaves));
}

const PEM = "-----BEGIN PUBLIC KEY-----\nizmisljeni\n-----END PUBLIC KEY-----\n";

/** A day of `others` invented entries plus the receipt's own, with a record the fake check trusts. */
async function dayWith(source: PortableRecordSource, others = 6): Promise<PortableDailyRootSource> {
  return async (entry) => {
    const entries = [...otherEntries(others), entry];
    const root = await rootOf(entries);
    const record = { count: entries.length, day: "2026-11-20", keyId: "dnevni-kljuc", root };
    void source;
    return {
      status: "included",
      dailyRoot: {
        record: encoder.encode(canonicalizeJcs({ ...record, signature: "izmisljeni-potpis" })),
        day: record.day,
        root,
        count: record.count,
        publicKeyPem: PEM,
        entries,
      },
    };
  };
}

/** Stands in for the SRV-1311 signature check: the record's own fields, with the expected key. */
const fakeCheck: DailyRootCheck = async (record, key) => {
  if (new TextDecoder().decode(key) !== PEM) return { ok: false };
  const parsed = JSON.parse(new TextDecoder().decode(record)) as {
    day: string;
    root: string;
    count: number;
    keyId: string;
  };
  return { ok: true, day: parsed.day, root: parsed.root, count: parsed.count, keyId: parsed.keyId };
};

async function built(source?: PortableRecordSource, dailyRoot = PENDING_DAILY_ROOT) {
  const result = await buildPortableRecord({
    submissionId: SUBMISSION_ID,
    source: source ?? (await sourceOf()),
    dailyRoot,
    origin: ORIGIN,
    labels: LABELS,
  });
  if (result.status !== "built") throw new Error(`refused: ${result.reason}`);
  return result;
}

async function builtWithRoot() {
  const source = await sourceOf();
  return built(source, await dayWith(source));
}

/** The same files with one byte of `name` flipped. */
function flipped(files: Map<string, Uint8Array>, name: string, at = 0): Map<string, Uint8Array> {
  const copy = new Map(files);
  const bytes = Uint8Array.from(copy.get(name)!);
  bytes[at] = bytes[at]! ^ 0x01;
  copy.set(name, bytes);
  return copy;
}

/** Rewrites the manifest so it names the current bytes of every file. */
function remanifested(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const manifest = JSON.parse(new TextDecoder().decode(files.get(FILES.manifest))) as {
    files: { name: string; sha256: string; bytes: number }[];
  };
  for (const line of manifest.files) {
    const bytes = files.get(line.name)!;
    line.sha256 = createSha(bytes);
    line.bytes = bytes.byteLength;
  }
  return new Map(files).set(FILES.manifest, encoder.encode(canonicalizeJcs(manifest)));
}

function createSha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("buildPortableRecord", () => {
  it("gives the same bytes for the same submission, with the manifest first", async () => {
    const first = await built();
    const second = await built();
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.names).toEqual([
      FILES.manifest,
      FILES.receiptKey,
      FILES.pdf,
      FILES.receipt,
      FILES.text,
    ]);
    const withRoot = await builtWithRoot();
    expect(withRoot.names).toEqual([
      FILES.manifest,
      FILES.dailyRoot,
      FILES.dailyRootKey,
      FILES.receiptKey,
      FILES.proof,
      FILES.pdf,
      FILES.receipt,
      FILES.text,
    ]);
  });

  it("carries the exact text, the receipt, its key and a manifest of their SHA-256", async () => {
    const files = unzipStored((await built()).bytes);
    expect(new TextDecoder().decode(files.get(FILES.text))).toBe(TEXT);
    const receipt = JSON.parse(new TextDecoder().decode(files.get(FILES.receipt))) as {
      payload: unknown;
    };
    expect(receipt.payload).toEqual(PAYLOAD);
    expect(JSON.parse(new TextDecoder().decode(files.get(FILES.receiptKey)))).toEqual(RECEIPT_KEY);
    const manifest = JSON.parse(new TextDecoder().decode(files.get(FILES.manifest))) as {
      format: string;
      dailyRoot: string;
      files: { name: string }[];
    };
    expect(manifest.format).toBe("ductura.portable-record.v1");
    expect(manifest.dailyRoot).toBe("pending");
    expect(manifest.files.map((f) => f.name)).toEqual([...files.keys()].slice(1));
  });

  it("refuses a text whose SHA-256 is not the receipt's", async () => {
    const source = await sourceOf(PAYLOAD, TEXT.replace("waste", "wastE"));
    expect(
      await buildPortableRecord({
        submissionId: SUBMISSION_ID,
        source,
        dailyRoot: PENDING_DAILY_ROOT,
        origin: ORIGIN,
        labels: LABELS,
      }),
    ).toEqual({ status: "refused", reason: "text_mismatch" });
  });

  it("refuses a receipt of another submission, a changed digest and a key that did not sign it", async () => {
    const source = await sourceOf();
    const ask = (over: Partial<PortableRecordSource>, submissionId = SUBMISSION_ID) =>
      buildPortableRecord({
        submissionId,
        source: { ...source, ...over },
        dailyRoot: PENDING_DAILY_ROOT,
        origin: ORIGIN,
        labels: LABELS,
      });
    expect(await ask({}, "00000000-0000-4000-8000-000000000001")).toMatchObject({
      reason: "receipt_malformed",
    });
    expect(await ask({ payloadDigestSha256: "0".repeat(64) })).toMatchObject({
      reason: "receipt_malformed",
    });
    expect(await ask({ receiptPayload: ` ${source.receiptPayload}` })).toMatchObject({
      reason: "receipt_malformed",
    });
    const otherKey = {
      ...RECEIPT_KEY,
      keyBase64Url: "MCowBQYDK2VwAyEAO2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik",
    };
    expect(await ask({ key: otherKey })).toMatchObject({ reason: "receipt_unverified" });
    expect(await ask({ key: null })).toMatchObject({ reason: "receipt_malformed" });
  });

  it("refuses a daily root that does not hold the receipt's entry or does not give its root", async () => {
    const source = await sourceOf();
    const good = await dayWith(source);
    const ask = (dailyRoot: PortableDailyRootSource) =>
      buildPortableRecord({
        submissionId: SUBMISSION_ID,
        source,
        dailyRoot,
        origin: ORIGIN,
        labels: LABELS,
      });
    const without: PortableDailyRootSource = async (entry) => {
      const read = await good(entry);
      if (read.status !== "included") throw new Error("unexpected");
      const entries = read.dailyRoot.entries.filter((e) => e.receiptId !== entry.receiptId);
      return {
        status: "included",
        dailyRoot: { ...read.dailyRoot, entries, count: entries.length },
      };
    };
    const otherRoot: PortableDailyRootSource = async (entry) => {
      const read = await good(entry);
      if (read.status !== "included") throw new Error("unexpected");
      return { status: "included", dailyRoot: { ...read.dailyRoot, root: "0".repeat(64) } };
    };
    expect(await ask(without)).toMatchObject({ reason: "daily_root_mismatch" });
    expect(await ask(otherRoot)).toMatchObject({ reason: "daily_root_mismatch" });
    expect(await ask(async () => ({ status: "unavailable" }))).toMatchObject({
      reason: "daily_root_unavailable",
    });
  });

  it("names the receipt's entry as the SRV-1311 log entry of the submission", async () => {
    const source = await sourceOf();
    const seen: PortableLogEntry[] = [];
    await built(source, async (entry) => {
      seen.push(entry);
      return { status: "pending" };
    });
    expect(seen).toEqual([
      {
        receiptId: SUBMISSION_ID,
        acceptedAt: "2026-11-20T10:59:00.654Z",
        digest: source.payloadDigestSha256,
      },
    ]);
  });
});

describe("verifyPortableRecord", () => {
  it("passes the unpacked record without a daily root and with one", async () => {
    const pending = await verifyPortableRecord(unzipStored((await built()).bytes), fakeCheck);
    expect(pending).toEqual({
      ok: true,
      submissionId: SUBMISSION_ID,
      signedAt: PAYLOAD.signedAt,
      receiptKeyId: RECEIPT_KEY.keyId,
      dailyRoot: null,
    });
    const included = await verifyPortableRecord(
      unzipStored((await builtWithRoot()).bytes),
      fakeCheck,
    );
    expect(included).toMatchObject({
      ok: true,
      dailyRoot: { day: "2026-11-20", keyId: "dnevni-kljuc" },
    });
  });

  it("fails on one changed byte of the text, whether or not the manifest is rewritten", async () => {
    const files = unzipStored((await builtWithRoot()).bytes);
    const at = TEXT.indexOf(SENTENCE);
    expect(await verifyPortableRecord(flipped(files, FILES.text, at), fakeCheck)).toEqual({
      ok: false,
      problem: "file_mismatch",
    });
    expect(
      await verifyPortableRecord(remanifested(flipped(files, FILES.text, at)), fakeCheck),
    ).toEqual({ ok: false, problem: "text_mismatch" });
  });

  it("fails on a changed receipt, key, proof or root, and on a missing or extra file", async () => {
    const files = unzipStored((await builtWithRoot()).bytes);
    const verify = (changed: Map<string, Uint8Array>) => verifyPortableRecord(changed, fakeCheck);
    const receiptText = new TextDecoder().decode(files.get(FILES.receipt));
    const signedAtAt = receiptText.indexOf("10:59:00");
    expect(await verify(remanifested(flipped(files, FILES.receipt, signedAtAt + 1)))).toEqual({
      ok: false,
      problem: "receipt_invalid",
    });
    expect(await verify(remanifested(flipped(files, FILES.receiptKey, 30)))).toMatchObject({
      ok: false,
    });
    const proofText = new TextDecoder().decode(files.get(FILES.proof));
    const proofAt = proofText.indexOf('"proof":["') + 10;
    expect(await verify(remanifested(flipped(files, FILES.proof, proofAt)))).toEqual({
      ok: false,
      problem: "proof_invalid",
    });
    const otherKey = new Map(files).set(FILES.dailyRootKey, encoder.encode("drugi kljuc"));
    expect(await verify(remanifested(otherKey))).toEqual({
      ok: false,
      problem: "daily_root_invalid",
    });
    const missing = new Map(files);
    missing.delete(FILES.proof);
    expect(await verify(missing)).toEqual({ ok: false, problem: "file_missing" });
    const extra = new Map(files).set("drugo.txt", encoder.encode("x"));
    expect(await verify(extra)).toEqual({ ok: false, problem: "file_unexpected" });
    const noManifest = new Map(files);
    noManifest.delete(FILES.manifest);
    expect(await verify(noManifest)).toEqual({ ok: false, problem: "file_missing" });
  });

  it("fails when another student's receipt is put in its place", async () => {
    const files = unzipStored((await built()).bytes);
    const other = await sourceOf({
      ...PAYLOAD,
      submissionId: "00000000-0000-4000-8000-0000000000b2",
      principalId: STUDENT_B.id,
    });
    const swapped = new Map(files).set(
      FILES.receipt,
      encoder.encode(
        canonicalizeJcs({
          payload: JSON.parse(other.receiptPayload),
          payloadDigestSha256: other.payloadDigestSha256,
          signature: other.signature,
        }),
      ),
    );
    expect(await verifyPortableRecord(remanifested(swapped), fakeCheck)).toEqual({
      ok: false,
      problem: "receipt_malformed",
    });
  });
});

describe("the QR of the record's PDF (acceptance 3)", () => {
  /** The dark modules the PDF draws, from its inflated content streams, in drawing order. */
  function drawnSquares(pdf: Uint8Array): string[] {
    const text = Buffer.from(pdf).toString("latin1");
    const squares: string[] = [];
    for (const match of text.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      let body: string;
      try {
        body = inflateSync(Buffer.from(match[1]!, "latin1")).toString("latin1");
      } catch {
        body = match[1]!;
      }
      // pdf-lib draws a rectangle as a path moved into place: x y cm, then 0 0 m.
      const square = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n0 0 m\n/g;
      for (const op of body.matchAll(square)) {
        squares.push(`${Number(op[1]).toFixed(2)},${Number(op[2]).toFixed(2)}`);
      }
      // @cantoo/pdf-lib moves to the top-left corner, flips the y axis and draws the
      // whole path; the module's bottom-left corner is then y minus the path height.
      const flipped =
        /1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm\n1 0 0 1 0 0 cm\n1 0 0 1 0 0 cm\n1 0 0 -1 0 0 cm\n0 0 0 rg\n\[\] 0 d\n0 0 m\n([\d.]+) 0 l\n\3 ([\d.]+) l\n0 \4 l\nh\nf\n/g;
      for (const op of body.matchAll(flipped)) {
        squares.push(`${Number(op[1]).toFixed(2)},${(Number(op[2]) - Number(op[4])).toFixed(2)}`);
      }
    }
    return squares;
  }

  it("draws exactly the QR of /provjera with the submission id and SHA-256 in the fragment", async () => {
    const files = unzipStored((await built()).bytes);
    const pdf = files.get(FILES.pdf)!;
    const url = `${ORIGIN}/provjera#r=${SUBMISSION_ID}&o=${PAYLOAD.artifactSha256}`;
    const { data, size } = encode(url, { border: 4, ecc: "M" });
    const unit = 156 / size;
    const expected: string[] = [];
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark)
          expected.push(
            `${(45 + x * unit).toFixed(2)},${(117 + (size - 1 - y) * unit).toFixed(2)}`,
          );
      }),
    );
    expect(drawnSquares(pdf)).toEqual(expected);
    const fragment = new URLSearchParams(new URL(url).hash.slice(1));
    expect([...fragment.keys()]).toEqual(["r", "o"]);
    for (const secret of [STUDENT_A.name, STUDENT_A.email, SENTENCE, STUDENT_A.id]) {
      expect(url).not.toContain(secret);
    }
  });

  it("is the receipt PDF the student downloads, and no file names the student", async () => {
    const source = await sourceOf();
    const files = unzipStored((await built(source)).bytes);
    const receipt = JSON.parse(new TextDecoder().decode(files.get(FILES.receipt)));
    const pdf = await renderReceiptPdf(receipt, ORIGIN, LABELS);
    expect(Buffer.from(files.get(FILES.pdf)!).equals(Buffer.from(pdf))).toBe(true);
    for (const [name, bytes] of files) {
      const text = Buffer.from(bytes).toString("utf8");
      for (const person of [STUDENT_A, STUDENT_B]) {
        expect(text, name).not.toContain(person.name);
        expect(text, name).not.toContain(person.email);
      }
    }
    expect(submissionLogEntry(receipt).receiptId).toBe(SUBMISSION_ID);
  });
});
