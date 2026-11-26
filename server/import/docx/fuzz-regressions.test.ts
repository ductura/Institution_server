// ISTR-8: every input the Jazzer.js run (fuzz/docx) ever found to break the import
// stays here as a file in fuzz/docx/regressions/ and must now be answered with a
// code of the contract, never an exception. The ISTR-6 fixtures run through the
// same check, so the fuzz target itself cannot rot unnoticed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { check } from "../../../fuzz/docx/index.ts";

const regressions = join(import.meta.dirname, "../../../fuzz/docx/regressions");
const fixtures = join(import.meta.dirname, "../../../test-support/docx-zip/mammoth");
const filesOf = (dir: string, suffix: string) =>
  readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));

describe("fuzz target (ISTR-8)", () => {
  it("accepts the seed corpus (ISTR-6 fixtures)", () => {
    const files = filesOf(fixtures, ".docx");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(() => check(readFileSync(file))).not.toThrow();
  });

  it("answers every input found by the fuzzer without throwing", () => {
    for (const file of filesOf(regressions, ".bin")) {
      expect(() => check(readFileSync(file)), file).not.toThrow();
    }
  });

  it("answers empty, non-ZIP and truncated inputs with a refusal", () => {
    const fixture = readFileSync(filesOf(fixtures, ".docx")[0]!);
    for (const bytes of [
      new Uint8Array(0),
      Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0xff),
      fixture.subarray(0, fixture.length >> 1),
    ]) {
      expect(() => check(bytes)).not.toThrow();
    }
  });
});
