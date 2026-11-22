// The evidence path of `pnpm lokalno` and `pnpm stog:gore` (LOK-SRV-1)
// without PostgreSQL: the registration block taken from the committed SQL,
// the seed outside the checkout, and the server's evidence variables with the
// local S3 answering on loopback. The key registration itself runs against
// PostgreSQL in the stack (docs/lokalno/STOG.md, "Dokazi").
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  developmentKey,
  EVIDENCE_INSTITUTION,
  evidenceDir,
  registrationBlock,
  REGISTRATION_SETTINGS,
  startEvidenceStore,
} from "./evidence.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SQL = readFileSync(join(ROOT, "db/main/local/evidence-signing-key.sql"), "utf8");
const INSTITUTION = "00000000-0000-4000-8000-0000000000aa";

let dir: string | undefined;
let s3: Server | undefined;
afterEach(async () => {
  await new Promise((done) => (s3 === undefined ? done(undefined) : s3.close(done)));
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  s3 = undefined;
  dir = undefined;
});

const outsideRoot = (path: string) => {
  const rest = relative(ROOT, path);
  return rest.startsWith("..") || isAbsolute(rest);
};

describe("the registration block of evidence-signing-key.sql", () => {
  it("is the file's one DO block, with no psql variable or command left", () => {
    const block = registrationBlock(SQL.replace(/\r\n/gu, "\n"));
    expect(block.startsWith("DO $register$\n")).toBe(true);
    expect(block.endsWith("$register$;")).toBe(true);
    expect(block).toContain("INSERT INTO evidence.signing_key");
    expect(block).not.toMatch(/:'|\\(?:set|gset|if|endif)/u);
  });

  it("sets every ductus_local setting the block reads", () => {
    const read = [...registrationBlock(SQL).matchAll(/current_setting\('(ductus_local\.\w+)'\)/gu)];
    for (const [, name] of read) expect(REGISTRATION_SETTINGS).toContain(`'${name}'`);
    expect(read.length).toBeGreaterThan(0);
  });

  it("stops the stack when the file has no DO block", () => {
    expect(() => registrationBlock("BEGIN;\nCOMMIT;\n")).toThrow(/DO block/u);
  });
});

describe("the development seed", () => {
  it("lies under the home directory, outside the checkout, one per checkout", () => {
    const home = join(tmpdir(), "dom");
    const at = evidenceDir(ROOT, home);
    expect(at.startsWith(join(home, ".ductura"))).toBe(true);
    expect(outsideRoot(at)).toBe(true);
    expect(evidenceDir(ROOT, home)).toBe(at);
    expect(evidenceDir(join(ROOT, "drugi"), home)).not.toBe(at);
  });

  it("is made once and kept: a second start reads the same public key", async () => {
    const at = realpathSync(mkdtempSync(join(tmpdir(), "lok-srv-1-")));
    dir = at;
    const first = await developmentKey(ROOT, at);
    const second = await developmentKey(ROOT, at);
    expect(first.seed).toBe(join(at, "signing-seed"));
    expect(first.key.keyBase64Url).not.toBe("");
    expect(second.key).toEqual(first.key);
  });

  it("is refused inside the checkout", async () => {
    await expect(developmentKey(ROOT, join(ROOT, ".local", "lok-srv-1-test"))).rejects.toThrow(
      /signing_key_in_repository|not usable/u,
    );
    rmSync(join(ROOT, ".local", "lok-srv-1-test"), { recursive: true, force: true });
  });
});

describe("the server's evidence variables", () => {
  it("name the local S3 of the institution and the seed, and the S3 answers on loopback", async () => {
    const at = realpathSync(mkdtempSync(join(tmpdir(), "lok-srv-1-")));
    dir = at;
    const { seed } = await developmentKey(ROOT, at);
    const started = await startEvidenceStore(at, INSTITUTION, seed, 0);
    s3 = started.s3;
    const { env } = started;
    expect(env.NODE_ENV).toBe("development");
    expect(env.DUCTUS_DEV_SIGNING_KEY_FILE).toBe(seed);
    expect(env.EVIDENCE_S3_VS1_KEY_ID).toMatch(/^vs1[0-9a-f]+$/u);
    expect(env.EVIDENCE_S3_VS1_SECRET).not.toBe("");
    const domains = JSON.parse(env.EVIDENCE_STORAGE_DOMAINS ?? "") as {
      domains: { institutionId: string; endpoint: string }[];
    };
    expect(domains.domains).toHaveLength(1);
    expect(domains.domains[0]?.institutionId).toBe(INSTITUTION);
    expect(domains.domains[0]?.endpoint.startsWith("http://127.0.0.1:")).toBe(true);
    // Unsigned, so refused: the store is up and asks for its own key.
    const address = s3.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const answer = await fetch(`http://127.0.0.1:${port}/ductus-evidence-demo-fakultet/x`);
    expect(answer.status).toBe(403);
    expect(EVIDENCE_INSTITUTION).toBe("demo-fakultet");
  });
});
