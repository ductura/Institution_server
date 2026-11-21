// SRV-1311 acceptance 2: the CLI refuses a changed, removed or added entry
// and the wrong key, offline, with exit code 1; the untouched day exits 0.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDailyRootService,
  type DailyRootEntry,
  type DailyRootSigner,
} from "../../server/evidence/daily-root/index.ts";
import { readLocalFile } from "./index.ts";
import { parseArgs, parseEntries, runEvidenceVerify, USAGE } from "./verify.ts";

// Invented data only: an ephemeral key, receipts `receipt-<n>` and digests of made-up text.
const DAY = "2026-11-20";
const INSTITUTION = "0f0e0d0c-0b0a-4908-8706-050403020100";

function entry(n: number, minute = n): DailyRootEntry {
  return {
    receiptId: `receipt-${n}`,
    acceptedAt: new Date(Date.parse(`${DAY}T00:00:00.000Z`) + minute * 60_000).toISOString(),
    digest: createHash("sha256").update(`invented receipt ${n}`).digest("hex"),
  };
}

const entries = (count: number) => Array.from({ length: count }, (_, n) => entry(n));

function createFakeSigner(): DailyRootSigner & { publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = { algorithm: "Ed25519", keyId: "cli-test-key", keyVersion: "v1" } as const;
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    async sign(message) {
      const signature = sign(null, message, privateKey).toString("base64url");
      return {
        ok: true,
        value: { ...envelope, signatureEncoding: "raw", signatureBase64Url: signature },
      };
    },
    async publicVerificationKey() {
      const der = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
      return { ok: true, value: { ...envelope, encoding: "spki-der", keyBase64Url: der } };
    },
  };
}

const store = {
  async putImmutable() {
    return { status: "stored", storageRef: "memory:cli-test" } as const;
  },
};

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const signer = createFakeSigner();
const list = entries(7);
let dir: string;

const ndjson = (rows: readonly unknown[]) =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

function write(name: string, text: string | Uint8Array): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function args(over: { root?: string; entries?: string; key?: string } = {}): string[] {
  return [
    "--root",
    over.root ?? join(dir, "root.json"),
    "--entries",
    over.entries ?? join(dir, "entries.ndjson"),
    "--public-key",
    over.key ?? join(dir, "key.pem"),
  ];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "evidence-verify-"));
  const service = createDailyRootService({
    institutionId: INSTITUTION,
    readEntries: async () => list,
    signer,
    store,
  });
  const { bytes } = await service.build(DAY, new AbortController().signal);
  write("root.json", bytes);
  write("entries.ndjson", ndjson([...list].reverse()));
  write("key.pem", signer.publicPem);
  write("other.pem", createFakeSigner().publicPem);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("evidence-verify", () => {
  it("passes the untouched day, with entries in any order", async () => {
    const outcome = await runEvidenceVerify(args(), readLocalFile);
    expect(outcome).toEqual({ exitCode: 0, line: `ISPRAVNO: dan ${DAY}, unosa 7`, problem: null });
  });

  it("refuses a changed entry", async () => {
    const changed = list.map((e, i) => (i === 3 ? { ...e, digest: "0".repeat(64) } : e));
    const path = write("changed.ndjson", ndjson(changed));
    expect(await runEvidenceVerify(args({ entries: path }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "root_mismatch",
    });
  });

  it("refuses a removed entry", async () => {
    const path = write("removed.ndjson", ndjson(list.slice(0, -1)));
    expect(await runEvidenceVerify(args({ entries: path }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "count_mismatch",
    });
  });

  it("refuses an added entry", async () => {
    const path = write("added.ndjson", ndjson([...list, entry(50, 600)]));
    expect(await runEvidenceVerify(args({ entries: path }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "count_mismatch",
    });
  });

  it("refuses the wrong key", async () => {
    expect(
      await runEvidenceVerify(args({ key: join(dir, "other.pem") }), readLocalFile),
    ).toMatchObject({ exitCode: 1, problem: "signature_invalid" });
  });

  it("refuses a changed record, a missing file, a bad key file and bad arguments", async () => {
    const stored = JSON.parse(readFileSync(join(dir, "root.json"), "utf8"));
    const recounted = write("recounted.json", JSON.stringify({ ...stored, count: 6 }));
    expect(
      await runEvidenceVerify(
        args({ root: recounted, entries: write("six.ndjson", ndjson(list.slice(1))) }),
        readLocalFile,
      ),
    ).toMatchObject({ exitCode: 1, problem: "signature_invalid" });
    const forged = write("forged.json", '{"count":7,"day":"2026-11-19"}');
    expect(await runEvidenceVerify(args({ root: forged }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "record_malformed",
    });
    expect(
      await runEvidenceVerify(args({ entries: join(dir, "missing.ndjson") }), readLocalFile),
    ).toMatchObject({ exitCode: 1, problem: "file_unreadable" });
    const badKey = write("bad.pem", "not a key");
    expect(await runEvidenceVerify(args({ key: badKey }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "key_invalid",
    });
    const badLines = write("bad.ndjson", "{not json}\n");
    expect(await runEvidenceVerify(args({ entries: badLines }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "entries_malformed",
    });
    expect(await runEvidenceVerify(["--root"], readLocalFile)).toEqual({
      exitCode: 1,
      line: USAGE,
      problem: "usage",
    });
  });

  it("refuses a file above its bound before reading it", async () => {
    const big = write("big.json", " ".repeat(5000));
    expect(await runEvidenceVerify(args({ root: big }), readLocalFile)).toMatchObject({
      exitCode: 1,
      problem: "file_too_large",
    });
  });

  it("reads each option once and NDJSON with blank and CRLF lines", () => {
    expect(parseArgs(["--root", "a", "--entries", "b", "--public-key", "c"])).toEqual({
      "--root": "a",
      "--entries": "b",
      "--public-key": "c",
    });
    expect(parseArgs(["--root", "a", "--root", "b", "--public-key", "c"])).toBeNull();
    expect(
      parseArgs(["--root", "a", "--entries", "b", "--public-key", "c", "--x", "d"]),
    ).toBeNull();
    expect(parseEntries('{"a":1}\r\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseEntries("")).toEqual([]);
  });

  it("runs as a process with exit codes 0 and 1", () => {
    const run = (argv: string[]) =>
      spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8", timeout: 30_000 });
    const ok = run(args());
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("ISPRAVNO");
    const wrong = run(args({ key: join(dir, "other.pem") }));
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("signature_invalid");
  });
});
