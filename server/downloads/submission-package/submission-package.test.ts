// SRV-1807: the 24 hour link and the two things it hands out, over the
// invented submission of test-support/portable-record. Every id, key and text
// is invented.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LABELS,
  ORIGIN,
  SENTENCE,
  sourceOf,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";
import { PENDING_DAILY_ROOT, verifyPortableRecord } from "../portable-record/index.ts";

import {
  buildSubmissionPackage,
  checkPackageLink,
  issuePackageLink,
  PACKAGE_LINK_TTL_MS,
  REFERADA_CONFIRMATION_FILENAME,
} from "./index.ts";

const SESSION = "s".repeat(43);
const OTHER_SESSION = "t".repeat(43);
const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const OTHER_SUBMISSION = "00000000-0000-4000-8000-000000000009";

describe("the link", () => {
  it("is valid for 24 hours from its issue and then expires", () => {
    const link = issuePackageLink(SESSION, SUBMISSION_ID, "package", T0);
    expect(link.expiresAt).toBe("2026-11-22T10:00:00.000Z");
    expect(PACKAGE_LINK_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const at = (ms: number) => checkPackageLink(SESSION, SUBMISSION_ID, "package", link.token, ms);
    expect(at(T0)).toBe("valid");
    expect(at(T0 + PACKAGE_LINK_TTL_MS - 1)).toBe("valid");
    expect(at(T0 + PACKAGE_LINK_TTL_MS)).toBe("expired");
    expect(at(T0 + 3 * PACKAGE_LINK_TTL_MS)).toBe("expired");
  });

  it("is the same link for the same session, submission, kind and instant", () => {
    expect(issuePackageLink(SESSION, SUBMISSION_ID, "referada", T0)).toEqual(
      issuePackageLink(SESSION, SUBMISSION_ID, "referada", T0),
    );
  });

  it("does not move to another session, submission or kind", () => {
    const { token } = issuePackageLink(SESSION, SUBMISSION_ID, "package", T0);
    expect(checkPackageLink(OTHER_SESSION, SUBMISSION_ID, "package", token, T0)).toBe("invalid");
    expect(checkPackageLink(SESSION, OTHER_SUBMISSION, "package", token, T0)).toBe("invalid");
    expect(checkPackageLink(SESSION, SUBMISSION_ID, "referada", token, T0)).toBe("invalid");
  });

  it("cannot have its expiry extended or be forged", () => {
    const { token } = issuePackageLink(SESSION, SUBMISSION_ID, "package", T0);
    const [expiry, mac] = token.split(".") as [string, string];
    const later = `${Number(expiry) + PACKAGE_LINK_TTL_MS}.${mac}`;
    expect(checkPackageLink(SESSION, SUBMISSION_ID, "package", later, T0)).toBe("invalid");
    for (const bad of [
      "",
      "x",
      `${expiry}.`,
      `.${mac}`,
      `${expiry}.${"A".repeat(43)}`,
      `${expiry}.${mac}x`,
      "1".repeat(16) + "." + mac,
    ]) {
      expect(checkPackageLink(SESSION, SUBMISSION_ID, "package", bad, T0)).toBe("invalid");
    }
  });
});

async function build(kind: "package" | "referada", text = TEXT) {
  return buildSubmissionPackage(kind, {
    submissionId: SUBMISSION_ID,
    source: await sourceOf(undefined, text),
    dailyRoot: PENDING_DAILY_ROOT,
    origin: ORIGIN,
    labels: LABELS,
    confirmationCode: null,
  });
}

const noDailyRoot = async () => ({ ok: false }) as const;

describe("the package (acceptance 1)", () => {
  it("is the portable record: its one manifest is checked offline", async () => {
    const built = await build("package");
    if (built.status !== "built") throw new Error("refused");
    expect(built.contentType).toBe("application/zip");
    expect(built.filename).toBe("prenosivi-zapis.zip");
    expect(built.sha256).toBe(createHash("sha256").update(built.bytes).digest("hex"));
    const files = unzipStored(built.bytes);
    expect(await verifyPortableRecord(files, noDailyRoot)).toMatchObject({
      ok: true,
      submissionId: SUBMISSION_ID,
    });
    expect(Buffer.from(files.get("rad.json")!).toString("utf8")).toBe(TEXT);
  });

  it("fails the offline check when one byte of the work changes", async () => {
    const built = await build("package");
    if (built.status !== "built") throw new Error("refused");
    const files = unzipStored(built.bytes);
    const text = Uint8Array.from(files.get("rad.json")!);
    text[text.length - 3] = text[text.length - 3]! ^ 1;
    files.set("rad.json", text);
    expect(await verifyPortableRecord(files, noDailyRoot)).toMatchObject({ ok: false });
  });

  it("is the same bytes every time", async () => {
    const [first, second] = [await build("package"), await build("package")];
    if (first.status !== "built" || second.status !== "built") throw new Error("refused");
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);
  });
});

describe("the confirmation for the registrar (acceptance 2)", () => {
  it("is the receipt PDF of the package, with no text of the work in it", async () => {
    const built = await build("referada");
    const record = await build("package");
    if (built.status !== "built" || record.status !== "built") throw new Error("refused");
    expect(built.contentType).toBe("application/pdf");
    expect(built.filename).toBe(REFERADA_CONFIRMATION_FILENAME);
    expect(built.sha256).toBe(createHash("sha256").update(built.bytes).digest("hex"));
    // The same stored values as the package: the very PDF inside its ZIP.
    expect(
      Buffer.from(built.bytes).equals(
        Buffer.from(unzipStored(record.bytes).get("potvrda-predaje.pdf")!),
      ),
    ).toBe(true);
    const raw = Buffer.from(built.bytes).toString("latin1");
    expect(raw).not.toContain(SENTENCE);
    expect(raw).not.toContain("composting");
    expect((await PDFDocument.load(built.bytes)).getPageCount()).toBeGreaterThan(0);
    // The text the PDF shows, not its bytes (streams may be compressed): the receipt's fields only.
    const shown = await extractText(await getDocumentProxy(Uint8Array.from(built.bytes)), {
      mergePages: true,
    });
    expect(shown.text).toContain(SUBMISSION_ID);
    expect(shown.text).not.toContain("composting");
    expect(shown.text).not.toContain("Invented text");
  });

  it("is refused, with no bytes, when the text does not match the receipt", async () => {
    const built = await build("referada", TEXT.replace("waste", "wastE"));
    expect(built).toEqual({ status: "refused", reason: "text_mismatch" });
  });
});
