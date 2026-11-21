// SRV-1312 acceptance 1 and 2: the same CLI as the daily root (SRV-1311)
// passes an unpacked portable record with no network and no database, and one
// changed byte of the text fails it. The daily root is signed for real in the
// SRV-1311 format (an ephemeral key); every other value is invented.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../../server/domain/index.ts";
import {
  buildPortableRecord,
  PENDING_DAILY_ROOT,
  PORTABLE_RECORD_FILES as FILES,
  type PortableDailyRootSource,
} from "../../server/downloads/portable-record/index.ts";
import {
  LABELS,
  ORIGIN,
  sourceOf,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../test-support/portable-record/index.ts";
import {
  createDailyRootService,
  type DailyRootEntry,
  type DailyRootSigner,
} from "../../server/evidence/daily-root/index.ts";

import { listLocalDirectory, readLocalFile } from "./index.ts";
import { runPortableRecordVerify } from "./portable-record.ts";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const INSTITUTION = "0f0e0d0c-0b0a-4908-8706-050403020100";

function createSigner(): DailyRootSigner & { publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const envelope = { algorithm: "Ed25519", keyId: "dnevni-kljuc-test", keyVersion: "v1" } as const;
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

/** Invented other receipts of the same day. */
const others: DailyRootEntry[] = Array.from({ length: 5 }, (_, n) => ({
  receiptId: `izmisljena-potvrda-${n}`,
  acceptedAt: `2026-11-20T0${n}:30:00.000Z`,
  digest: String(n).repeat(64),
}));

const signer = createSigner();

/** The day's root signed for real over the receipt's entry and the others. */
const signedDay: PortableDailyRootSource = async (entry) => {
  const entries = [...others, { ...entry }];
  const service = createDailyRootService({
    institutionId: INSTITUTION,
    readEntries: async () => entries,
    signer,
    store: { putImmutable: async () => ({ status: "stored", storageRef: "memory:test" }) as const },
  });
  const stored = await service.build("2026-11-20", new AbortController().signal);
  const record = JSON.parse(Buffer.from(stored.bytes).toString("utf8")) as {
    day: string;
    root: string;
    count: number;
  };
  return {
    status: "included",
    dailyRoot: { record: stored.bytes, ...record, publicKeyPem: signer.publicPem, entries },
  };
};

let base: string;

async function unpacked(name: string, dailyRoot: PortableDailyRootSource): Promise<string> {
  const built = await buildPortableRecord({
    submissionId: SUBMISSION_ID,
    source: await sourceOf(),
    dailyRoot,
    origin: ORIGIN,
    labels: LABELS,
  });
  if (built.status !== "built") throw new Error(built.reason);
  const dir = join(base, name);
  mkdirSync(dir);
  for (const [file, bytes] of unzipStored(built.bytes)) writeFileSync(join(dir, file), bytes);
  return dir;
}

const io = { readFile: readLocalFile, listDirectory: listLocalDirectory, join };
const run = (dir: string) => runPortableRecordVerify(["--record", dir], io);

/** Flips one bit of a file in place. */
function flip(dir: string, file: string, at: number): void {
  const bytes = readFileSync(join(dir, file));
  bytes[at] = bytes[at]! ^ 0x01;
  writeFileSync(join(dir, file), bytes);
}

let withRoot: string;
let pending: string;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "portable-record-"));
  withRoot = await unpacked("s-korijenom", signedDay);
  pending = await unpacked("bez-korijena", PENDING_DAILY_ROOT);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("evidence-verify --record", () => {
  it("passes the unpacked record as a real process, with the signed daily root and before it", () => {
    for (const [dir, day] of [
      [withRoot, "dnevni korijen 2026-11-20 (kljuc dnevni-kljuc-test)"],
      [pending, "dnevni korijen jos nije zatvoren"],
    ] as const) {
      const result = spawnSync(process.execPath, [CLI, "--record", dir], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `ISPRAVNO: predaja ${SUBMISSION_ID}, kljuc potvrde izmisljeni-kljuc, ${day}\n`,
      );
    }
  });

  it("fails on one changed byte of the text, as a real process", async () => {
    const dir = await unpacked("promijenjen-tekst", signedDay);
    flip(dir, FILES.text, TEXT.indexOf("composting"));
    const result = spawnSync(process.execPath, [CLI, "--record", dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("NEISPRAVNO: file_mismatch\n");
  });

  it("fails on a daily root signed by another key or changed after signing", async () => {
    const otherKey = await unpacked("drugi-kljuc", signedDay);
    writeFileSync(join(otherKey, FILES.dailyRootKey), createSigner().publicPem);
    const manifest = JSON.parse(readFileSync(join(otherKey, FILES.manifest), "utf8")) as {
      files: { name: string; sha256: string; bytes: number }[];
    };
    expect(await run(otherKey)).toMatchObject({ exitCode: 1, problem: "file_mismatch" });
    // With the manifest rewritten to the new bytes, the signature check itself fails.
    for (const line of manifest.files) {
      const bytes = readFileSync(join(otherKey, line.name));
      line.sha256 = createHash("sha256").update(bytes).digest("hex");
      line.bytes = bytes.byteLength;
    }
    writeFileSync(join(otherKey, FILES.manifest), canonicalizeJcs(manifest));
    expect(await run(otherKey)).toEqual({
      exitCode: 1,
      line: "NEISPRAVNO: daily_root_invalid",
      problem: "daily_root_invalid",
    });
  });

  it("refuses an unknown file, a missing directory and a wrong call", async () => {
    const dir = await unpacked("visak", PENDING_DAILY_ROOT);
    writeFileSync(join(dir, "drugo.txt"), "x");
    expect(await run(dir)).toMatchObject({ exitCode: 1, problem: "file_unexpected" });
    expect(await run(join(base, "nema"))).toMatchObject({
      exitCode: 1,
      problem: "file_unreadable",
    });
    expect(await runPortableRecordVerify(["--record"], io)).toMatchObject({ problem: "usage" });
    expect(await runPortableRecordVerify(["--record", pending, "x"], io)).toMatchObject({
      problem: "usage",
    });
  });
});
