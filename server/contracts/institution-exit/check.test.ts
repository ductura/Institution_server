import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { checkInstitutionExitManifestV1 } from "./check.ts";
import {
  INSTITUTION_EXIT_ACTOR_V1,
  INSTITUTION_EXIT_CLASS_COUNT,
  INSTITUTION_EXIT_NEVER_V1,
  INSTITUTION_EXIT_STATES_V1,
  InstitutionExitHandoverV1,
  InstitutionExitRequestV1,
  type InstitutionExitManifestV1,
} from "./package.ts";

// SRV-1810 (plan M10.6-P01, D-274 MQ12). All data is invented.

const ID = "00000000-0000-4000-8000-0000000000a1";
const H = "a".repeat(64);

function manifest(): InstitutionExitManifestV1 {
  return {
    manifestSchema: "ductura-institution-exit-v1",
    exitId: ID,
    institutionId: "00000000-0000-4000-8000-0000000000b2",
    writtenRequestRef: "ZAHTJEV-TEST-1",
    recipientLabel: "Primatelj A",
    startedBy: "operator",
    generatedAt: "2027-01-01T10:00:00.000Z",
    deletesNothing: true,
    files: Array.from({ length: INSTITUTION_EXIT_CLASS_COUNT }, (_, i) => ({
      path: `data/class-${String(i + 1).padStart(2, "0")}.jsonl`,
      dataClass: i + 1,
      rowCount: 0,
      byteLength: 0,
      sha256: H,
    })),
  };
}

describe("institution exit manifest v1", () => {
  it("accepts a complete manifest", () => {
    expect(checkInstitutionExitManifestV1(manifest())).toEqual({ ok: true, manifest: manifest() });
  });

  it("is operator only and deletes nothing", () => {
    expect(INSTITUTION_EXIT_ACTOR_V1).toBe("operator");
    expect(
      checkInstitutionExitManifestV1({ ...manifest(), startedBy: "institution_admin" }),
    ).toEqual({ ok: false, code: "MANIFEST_INVALID" });
    expect(checkInstitutionExitManifestV1({ ...manifest(), deletesNothing: false })).toEqual({
      ok: false,
      code: "MANIFEST_INVALID",
    });
    expect(
      Value.Check(InstitutionExitHandoverV1, {
        exitId: ID,
        manifestSha256: H,
        recipientLabel: "A",
        handedOverAt: "2027-01-01T10:00:00.000Z",
        deletion: "delete",
      }),
    ).toBe(false);
    expect(INSTITUTION_EXIT_NEVER_V1).toEqual([
      "delete-data",
      "change-retention",
      "release-legal-hold",
      "start-from-user-route",
    ]);
    expect(INSTITUTION_EXIT_STATES_V1).not.toContain("deleted");
  });

  it.each([
    ["extra key", { ...manifest(), extra: 1 }],
    ["wrong schema", { ...manifest(), manifestSchema: "ductura-institution-exit-v2" }],
    [
      "upper-case hash",
      { ...manifest(), files: [{ ...manifest().files[0], sha256: "A".repeat(64) }] },
    ],
    [
      "path traversal",
      { ...manifest(), files: [{ ...manifest().files[0], path: "data/../x.jsonl" }] },
    ],
    ["class 31", { ...manifest(), files: [{ ...manifest().files[0], dataClass: 31 }] }],
    ["negative rows", { ...manifest(), files: [{ ...manifest().files[0], rowCount: -1 }] }],
    ["empty request ref", { ...manifest(), writtenRequestRef: "" }],
    ["not an object", null],
  ])("refuses %s", (_name, value) => {
    expect(checkInstitutionExitManifestV1(value)).toEqual({ ok: false, code: "MANIFEST_INVALID" });
  });

  it("refuses unsorted and duplicate files", () => {
    const m = manifest();
    expect(checkInstitutionExitManifestV1({ ...m, files: [...m.files].reverse() })).toEqual({
      ok: false,
      code: "FILES_NOT_SORTED",
    });
    const files = [...m.files];
    files[1] = { ...files[0] } as (typeof files)[number];
    expect(checkInstitutionExitManifestV1({ ...m, files })).toEqual({
      ok: false,
      code: "FILE_PATH_DUPLICATE",
    });
  });

  it("refuses a manifest that leaves a data class out", () => {
    const m = manifest();
    expect(checkInstitutionExitManifestV1({ ...m, files: m.files.slice(1) })).toEqual({
      ok: false,
      code: "DATA_CLASS_MISSING",
    });
  });

  it("keeps the request closed and short", () => {
    const ok = {
      institutionId: ID,
      writtenRequestRef: "ZAHTJEV-TEST-1",
      recipientLabel: "Primatelj A",
    };
    expect(Value.Check(InstitutionExitRequestV1, ok)).toBe(true);
    expect(
      Value.Check(InstitutionExitRequestV1, { ...ok, writtenRequestRef: "x".repeat(121) }),
    ).toBe(false);
    expect(Value.Check(InstitutionExitRequestV1, { ...ok, email: "a@b.invalid" })).toBe(false);
  });

  it("is not mounted as a route", async () => {
    const { ROUTES } = await import("../index.ts");
    expect(ROUTES.filter((route) => /exit/i.test(route.path))).toEqual([]);
  });
});
