// SRV-1902: the 24 hour link to the ZIP of all submissions of an assignment and
// the checks of the ZIP builder. Every token, id and byte is invented.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { unzipStored } from "../../../test-support/portable-record/index.ts";

import { buildSubmissionsZip, submittedStudents, type BulkRoster } from "./build.ts";
import { BULK_LINK_TTL_MS, checkBulkLink, issueBulkLink } from "./link.ts";

const SESSION = "s".repeat(43);
const A = "5e2b7c41-9d3a-4f08-b6e1-2c7a9f0d3b58";
const B = "0b9d4e27-3c61-4a8f-9e25-7d1f6a4c8e30";
const NOW = Date.parse("2026-11-21T10:00:00.000Z");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

describe("the bulk link", () => {
  it("is valid for 24 hours for its session, assignment and format only", () => {
    const link = issueBulkLink(SESSION, A, "pdf", NOW);
    expect(link.expiresAt).toBe(new Date(NOW + BULK_LINK_TTL_MS).toISOString());
    expect(checkBulkLink(SESSION, A, "pdf", link.token, NOW)).toBe("valid");
    expect(checkBulkLink(SESSION, A, "pdf", link.token, NOW + BULK_LINK_TTL_MS - 1)).toBe("valid");
    expect(checkBulkLink(SESSION, A, "pdf", link.token, NOW + BULK_LINK_TTL_MS)).toBe("expired");
    expect(checkBulkLink("x".repeat(43), A, "pdf", link.token, NOW)).toBe("invalid");
    expect(checkBulkLink(SESSION, B, "pdf", link.token, NOW)).toBe("invalid");
    expect(checkBulkLink(SESSION, A, "docx", link.token, NOW)).toBe("invalid");
  });

  it("refuses a longer expiry and a malformed token", () => {
    const link = issueBulkLink(SESSION, A, "pdf", NOW);
    const [, mac] = link.token.split(".");
    expect(checkBulkLink(SESSION, A, "pdf", `${NOW + 10 * BULK_LINK_TTL_MS}.${mac}`, NOW)).toBe(
      "invalid",
    );
    expect(checkBulkLink(SESSION, A, "pdf", "nije-poveznica", NOW)).toBe("invalid");
    expect(checkBulkLink(SESSION, A, "pdf", `99999999999999999.${mac}`, NOW)).toBe("invalid");
  });
});

function roster(over: Partial<BulkRoster> = {}): BulkRoster {
  const pdf = bytes("%PDF-izmisljeni-a");
  const docx = bytes("PK-izmisljeni-a");
  const row = {
    familyName: "Izmišljena",
    givenName: "Ana",
    submitted: true,
    submittedMinute: "2026-11-20T10:58:00.000Z",
    afterDeadline: false,
    pdfName: "izmisljena-ana-11111111.pdf",
    pdfSha256: sha256(pdf),
    docxName: "izmisljena-ana-11111111.docx",
    docxSha256: sha256(docx),
  };
  const empty = {
    familyName: "Bez",
    givenName: "Predaje",
    submitted: false,
    submittedMinute: null,
    afterDeadline: null,
    pdfName: null,
    pdfSha256: null,
    docxName: null,
    docxSha256: null,
  };
  return {
    rows: [row, empty],
    files: [
      { name: row.pdfName, bytes: pdf },
      { name: row.docxName, bytes: docx },
    ],
    studentIds: [A, B],
    ...over,
  };
}

describe("buildSubmissionsZip", () => {
  it("takes the files of the format, the receipt next to each and the fingerprints", () => {
    expect(submittedStudents(roster())).toEqual([A]);
    const receipt = bytes("%PDF-potvrda");
    const zip = buildSubmissionsZip(roster(), "docx", new Map([[A, receipt]]));
    const files = unzipStored(zip.bytes);
    expect([...files.keys()]).toEqual([
      "izmisljena-ana-11111111.docx",
      "izmisljena-ana-11111111-potvrda.pdf",
      "otisci.sha256",
    ]);
    expect(zip.sha256).toBe(sha256(zip.bytes));
    expect(buildSubmissionsZip(roster(), "docx", new Map([[A, receipt]])).sha256).toBe(zip.sha256);
  });

  it("throws when a file is not the one its row names, or a receipt has no submitted work", () => {
    const changed = roster();
    const swapped = roster({
      files: [{ name: changed.files[0]!.name, bytes: bytes("%PDF-drugi") }, changed.files[1]!],
    });
    expect(() => buildSubmissionsZip(swapped, "pdf", new Map())).toThrow();
    expect(() => buildSubmissionsZip(roster(), "pdf", new Map([[B, bytes("%PDF-")]]))).toThrow();
    expect(() => submittedStudents(roster({ studentIds: [A] }))).toThrow();
  });
});
