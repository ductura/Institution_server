// Ported from Ductus src/application/ports/evidence-object-key.test.ts at
// d52a92c3 (the key part; the in-memory store part is in
// server/external/storage) and the package id check of
// src/application/ports/evidence-ingest.test.ts (S-0.19, DAN-732).
import { describe, expect, it } from "vitest";

import {
  evidenceObjectKey,
  evidenceStorageRef,
  isEvidencePackageId,
  isInstitutionId,
  isSha256Hex,
  isStorageDomainLabel,
} from "./object-key.ts";

// Synthetic ids only.
const A = "00000000-0000-4000-8000-00000000000a";
const HASH = "a".repeat(64);

describe("evidence object key", () => {
  it("takes an institution id only as a lowercase UUID", () => {
    expect(isInstitutionId(A)).toBe(true);
    expect(isInstitutionId("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    for (const id of [
      "",
      A.toUpperCase(),
      `{${A}}`,
      A.replace(/-/g, ""),
      `${A} `,
      `${A}\n`,
      `${A}/x`,
      `../${A}`,
      "00000000-0000-4000-8000-00000000000g",
      "０0000000-0000-4000-8000-00000000000a",
      A.slice(0, -1),
      `${A}0`,
      7,
      null,
      undefined,
    ]) {
      expect(isInstitutionId(id)).toBe(false);
    }
  });

  it("builds v2/<institution>/<package>/<hash>.json and nothing else", () => {
    expect(
      evidenceObjectKey({ institutionId: A, evidencePackageId: "paket-1", segmentHash: HASH }),
    ).toEqual(["v2", A, "paket-1", `${HASH}.json`]);

    for (const bad of [
      { institutionId: A.toUpperCase() },
      { institutionId: undefined },
      { evidencePackageId: "Paket-1" },
      { evidencePackageId: "a/b" },
      { evidencePackageId: ".." },
      { segmentHash: HASH.toUpperCase() },
      { segmentHash: `${HASH}0` },
    ]) {
      expect(
        evidenceObjectKey({
          institutionId: A,
          evidencePackageId: "paket-1",
          segmentHash: HASH,
          ...bad,
        }),
      ).toBeNull();
    }
  });

  it("keeps the storage domain label and the key in storageRef, never an endpoint", () => {
    const key = ["v2", A, "paket-1", `${HASH}.json`];
    expect(evidenceStorageRef("hr-zg-fpzg", key)).toBe(`hr-zg-fpzg:v2/${A}/paket-1/${HASH}.json`);
    expect(isStorageDomainLabel("a")).toBe(true);
    for (const label of ["", "-a", "A", "a.b", "a:b", "https://s3", "a/b", "a".repeat(64)]) {
      expect(isStorageDomainLabel(label)).toBe(false);
      expect(() => evidenceStorageRef(label, key)).toThrow(TypeError);
    }
  });

  it("takes only package ids that are safe as one object key segment", () => {
    for (const id of ["a", "0", "evidence-1", "a_b-c", "a".repeat(128)]) {
      expect(isEvidencePackageId(id)).toBe(true);
    }
    for (const id of ["", "Evidence-1", "-a", "a/b", "..", "a.b", "a\n", "ａ", "a".repeat(129)]) {
      expect(isEvidencePackageId(id)).toBe(false);
    }
  });

  it("takes a hash only as 64 lowercase hex digits", () => {
    expect(isSha256Hex(HASH)).toBe(true);
    for (const value of [
      "",
      HASH.toUpperCase(),
      `${HASH}0`,
      HASH.slice(1),
      `${"g".repeat(64)}`,
      7,
    ]) {
      expect(isSha256Hex(value)).toBe(false);
    }
  });
});
