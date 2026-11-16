// DAN-817 C: what the stack check counts as a stored object.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { storedObjects } from "./vs1-commit-check.ts";

describe("storedObjects", () => {
  it("counts every object file and never the bucket identity label", () => {
    const root = mkdtempSync(join(tmpdir(), "vs1-objects-"));
    try {
      const bucket = join(root, "ductus-evidence-demo-fakultet");
      mkdirSync(join(bucket, "v2", "ustanova", "paket"), { recursive: true });
      writeFileSync(join(bucket, "ductus-storage-identity.json"), "{}");
      expect(storedObjects(root)).toEqual([]);
      writeFileSync(join(bucket, "v2", "ustanova", "paket", "a.json"), "{}");
      expect(storedObjects(root)).toEqual([join(bucket, "v2", "ustanova", "paket", "a.json")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
