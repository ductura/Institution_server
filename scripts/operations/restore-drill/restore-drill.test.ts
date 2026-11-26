import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDeletionService, type ErasureTombstone } from "../../../server/deletion/index.ts";
import { createFakeSigner, createFakeStore, tombstone } from "./restore-drill.fixture.ts";
import { main } from "./cli.ts";
import { isDrillTarget, runInfrastructureDrill } from "./index.ts";

const SYNTHETIC = "5d5d5d5d-0000-4000-8000-000000000001";
const TARGET = "http://localhost:4000";
const TOMBSTONES: ErasureTombstone[] = [1, 2].map((s) => ({
  ...tombstone(s),
  institutionId: SYNTHETIC,
}));
const asItem = (t: ErasureTombstone) => ({
  dataClass: t.dataClass,
  subjectId: t.subjectId,
  contentSha256: t.contentSha256,
});
const KEPT = [{ dataClass: "access_log", subjectId: "kept-a", contentSha256: "a".repeat(64) }];

async function setup() {
  const signer = createFakeSigner();
  const built = await createDeletionService({
    signer,
    store: createFakeStore(),
  }).checkpointErasures({
    institutionId: SYNTHETIC,
    records: TOMBSTONES,
  });
  const key = await signer.publicVerificationKey();
  if (!built.ok || !key.ok) throw new Error("fake checkpoint failed");
  return { checkpoint: built.value.bytes, publicKey: key.value };
}
const base = async (over: Record<string, unknown> = {}) => ({
  target: TARGET,
  institutionId: SYNTHETIC,
  ...(await setup()),
  tombstones: TOMBSTONES,
  copy: [...KEPT, ...TOMBSTONES.map(asItem)],
  bucket: KEPT,
  ...over,
});

describe("restore drill on restored infrastructure (M11.2-P04)", () => {
  it("passes when the bucket holds exactly what may come back", async () => {
    expect(await runInfrastructureDrill(await base())).toEqual({
      ok: true,
      restored: 1,
      withheld: 2,
      bucket: { missing: 0, mismatched: 0, resurrected: 0 },
    });
  });

  it("refuses any target that is not local or a test name", async () => {
    for (const target of ["https://x.onrender.com", "https://ductura.org", "nope", 5, null]) {
      expect(await runInfrastructureDrill(await base({ target }))).toEqual({
        ok: false,
        problem: "target_not_local",
      });
    }
    expect(isDrillTarget("https://stog.test/x")).toBe(true);
    expect(isDrillTarget("https://evil.test.example.com")).toBe(false);
  });

  it("counts missing, changed and resurrected items", async () => {
    const result = await runInfrastructureDrill(
      await base({
        bucket: [{ ...KEPT[0], contentSha256: "b".repeat(64) }, asItem(TOMBSTONES[0]!)],
      }),
    );
    expect(result).toEqual({
      ok: false,
      problem: "bucket_differs",
      bucket: { missing: 0, mismatched: 1, resurrected: 1 },
    });
    expect(await runInfrastructureDrill(await base({ bucket: [] }))).toMatchObject({
      bucket: { missing: 1 },
    });
  });

  it("closes on a tombstone list that does not match the checkpoint", async () => {
    expect(await runInfrastructureDrill(await base({ tombstones: [TOMBSTONES[0]] }))).toMatchObject(
      { ok: false },
    );
  });

  it("refuses a real-looking institution and a malformed bucket", async () => {
    expect(
      await runInfrastructureDrill(
        await base({ institutionId: "0f0e0d0c-0b0a-4908-8706-050403020100" }),
      ),
    ).toEqual({ ok: false, problem: "not_synthetic" });
    expect(await runInfrastructureDrill(await base({ bucket: [{ subjectId: 1 }] }))).toEqual({
      ok: false,
      problem: "bucket_malformed",
    });
  });
});

describe("restore drill CLI", () => {
  it("exits 0, 1 and 2 and prints no input values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restore-drill-"));
    const files = await base();
    const put = (name: string, value: unknown) =>
      writeFileSync(join(dir, name), JSON.stringify(value));
    writeFileSync(
      join(dir, "checkpoint.json"),
      files.checkpoint instanceof Uint8Array
        ? Buffer.from(files.checkpoint)
        : JSON.stringify(files.checkpoint),
    );
    put("public-key.json", files.publicKey);
    put("tombstones.json", files.tombstones);
    put("copy.json", files.copy);
    put("bucket.json", files.bucket);
    const envOf = (target: string) =>
      Object.fromEntries([
        ["RESTORE_DRILL_TARGET", target],
        ["RESTORE_DRILL_INSTITUTION", SYNTHETIC],
      ]);
    const env = envOf(TARGET);
    const lines: string[] = [];
    const out = (line: string) => lines.push(line);
    const code = await main([dir], env, out);
    expect([code, lines[0]]).toEqual([0, expect.stringContaining('"ok":true')]);
    expect(await main([dir], envOf("https://ductura.org"), out)).toBe(1);
    expect(await main([join(dir, "missing")], env, out)).toBe(2);
    expect(await main([], {}, out)).toBe(2);
    expect(lines.join("\n")).not.toContain(SYNTHETIC);
  });
});
