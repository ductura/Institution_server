// DAN-817 B, plan of attack ductura/server#129 (K1-K4, P2) and the conditions of
// the contract confirmation (Ductus#1836 c.6911545693): the stack's seed,
// bucket label and server environment, and that a production NODE_ENV never
// falls back to the development signer or the local S3.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthConfigError, loadAuthConfig } from "../../server/external/srce-auth/index.ts";
import { loadEvidenceStorageConfig } from "../../server/external/storage/index.ts";
import {
  evidenceIngestDependencies,
  REFUSING_SIGNER,
  STORAGE_NOT_CONFIGURED,
} from "../../server/http/index.ts";
import {
  ensureBucketIdentity,
  ensureSeed,
  IDENTITY_KEY,
  inside,
  newS3Credentials,
  S3_BUCKET,
  seedFile,
  serverEvidenceEnv,
  storageDomains,
} from "./evidence.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
// Invented ids only.
const INSTITUTION = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vs1-evidence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("inside (Windows paths)", () => {
  const repo = "D:\\Ductura\\Institution_server";

  it.each([
    [repo, true],
    [`${repo}\\.local`, true],
    [`${repo}\\.local\\signing-seed`, true],
    ["d:\\ductura\\institution_server\\.local", true],
    ["D:/Ductura/Institution_server/.local", true],
    ["D:\\Ductura\\Institution_server-drugi\\.local", false],
    ["D:\\Ductura", false],
    ["C:\\Users\\izmisljeni\\.ductura\\stack-vs1-x", false],
  ])("judges %j inside the checkout: %s", (path, expected) => {
    expect(inside(path, repo, "win32")).toBe(expected);
  });

  it("keeps POSIX paths case-sensitive", () => {
    expect(inside("/srv/Repo/.local", "/srv/repo", "linux")).toBe(false);
    expect(inside("/srv/repo/.local", "/srv/repo", "linux")).toBe(true);
    expect(inside("/srv/repo-drugi", "/srv/repo", "linux")).toBe(false);
  });
});

describe("the signing seed (K1)", () => {
  it("lies outside the checkout when the stack directory is inside it", () => {
    const seed = seedFile(`${ROOT}/.stack/vs1`, ROOT, "/home/izmisljeni");
    expect(seed.startsWith("/home/izmisljeni/.ductura/stack-vs1-")).toBe(true);
    expect(seed.startsWith(`${ROOT}/`)).toBe(false);
    // One stack directory, one seed; another directory, another seed.
    expect(seedFile(`${ROOT}/.stack/vs1`, ROOT, "/home/izmisljeni")).toBe(seed);
    expect(seedFile(`${ROOT}/.stack/drugi`, ROOT, "/home/izmisljeni")).not.toBe(seed);
  });

  it("lies in the stack directory when that is outside the checkout", () => {
    expect(seedFile("/tmp/ductura-vs1-x/stack", ROOT, "/home/izmisljeni")).toBe(
      "/tmp/ductura-vs1-x/stack/signing-seed",
    );
  });

  it.each([[""], ["relativno"], [ROOT], [`${ROOT}/home`]])(
    "refuses HOME %j that is not absolute or lies in the checkout",
    (home) => {
      expect(() => seedFile(`${ROOT}/.stack/vs1`, ROOT, home)).toThrow(/HOME/u);
    },
  );

  it("is 32 bytes, 0600 in a 0700 directory, and never replaced", () => {
    const seed = join(dir, "a", "signing-seed");
    ensureSeed(seed, ROOT);
    const first = readFileSync(seed);
    expect(first.byteLength).toBe(32);
    expect(statSync(seed).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "a")).mode & 0o777).toBe(0o700);
    ensureSeed(seed, ROOT);
    expect(readFileSync(seed).equals(first)).toBe(true);
  });
});

describe("the signing seed through a link (Codex c.4584063033)", () => {
  // A stand-in checkout in /tmp, so the test never writes into the real one.
  it.each([["the HOME"], [".ductura"]])(
    "is refused when %s leads into the checkout, before any byte is written",
    (where) => {
      const checkout = join(dir, "checkout");
      const inner = join(checkout, "unutra");
      mkdirSync(inner, { recursive: true });
      const home = join(dir, "home");
      if (where === "the HOME") symlinkSync(inner, home);
      else {
        mkdirSync(home);
        symlinkSync(inner, join(home, ".ductura"));
      }
      const seed = seedFile(join(checkout, ".stack", "vs1"), checkout, home);
      expect(() => ensureSeed(seed, checkout)).toThrow(/inside the checkout/u);
      expect(readdirSync(inner)).toEqual([]);
    },
  );

  it("is written when HOME is a real directory outside the checkout", () => {
    const checkout = join(dir, "checkout");
    mkdirSync(checkout);
    const seed = seedFile(join(checkout, ".stack", "vs1"), checkout, join(dir, "home"));
    ensureSeed(seed, checkout);
    expect(readFileSync(seed).byteLength).toBe(32);
  });
});

describe("an existing seed directory (QA c.6913087963)", () => {
  it.each([[0o755], [0o777]])("with mode %o is made 0700 before the seed is written", (mode) => {
    const holder = join(dir, "postoji");
    mkdirSync(holder);
    chmodSync(holder, mode);
    ensureSeed(join(holder, "signing-seed"), ROOT);
    expect(statSync(holder).mode & 0o777).toBe(0o700);
    expect(statSync(join(holder, "signing-seed")).mode & 0o777).toBe(0o600);
  });

  it("is refused when a link stands in its place, and nothing is written there", () => {
    const target = join(dir, "cilj");
    mkdirSync(target);
    symlinkSync(target, join(dir, "veza"));
    expect(() => ensureSeed(join(dir, "veza", "signing-seed"), ROOT)).toThrow(/own directory/u);
    expect(readdirSync(target)).toEqual([]);
  });

  it("keeps an existing seed but narrows its mode to 0600", () => {
    const seed = join(dir, "s", "signing-seed");
    ensureSeed(seed, ROOT);
    const bytes = readFileSync(seed);
    chmodSync(seed, 0o644);
    ensureSeed(seed, ROOT);
    expect(statSync(seed).mode & 0o777).toBe(0o600);
    expect(readFileSync(seed).equals(bytes)).toBe(true);
  });

  it("refuses a seed that is a link", () => {
    const real = join(dir, "pravo");
    ensureSeed(join(real, "signing-seed"), ROOT);
    const holder = join(dir, "h");
    mkdirSync(holder, { mode: 0o700 });
    symlinkSync(join(real, "signing-seed"), join(holder, "signing-seed"));
    expect(() => ensureSeed(join(holder, "signing-seed"), ROOT)).toThrow(/regular file/u);
  });
});

describe("ownership of the seed (self-attack M2, M5)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a directory of another user and writes nothing in it", () => {
    const holder = join(dir, "tudji");
    mkdirSync(holder);
    vi.spyOn(process, "getuid").mockReturnValue(424_242);
    expect(() => ensureSeed(join(holder, "signing-seed"), ROOT)).toThrow(/own directory/u);
    expect(readdirSync(holder)).toEqual([]);
  });

  it("refuses a seed file of another user", () => {
    const seed = join(dir, "s", "signing-seed");
    ensureSeed(seed, ROOT);
    const own = process.getuid?.() ?? 0;
    // The directory is checked first (still ours), then the seed (now someone else's).
    vi.spyOn(process, "getuid").mockReturnValueOnce(own).mockReturnValue(424_242);
    expect(() => ensureSeed(seed, ROOT)).toThrow(/regular file/u);
  });
});

describe("the local S3 credentials (K3, K4)", () => {
  it("are new for every run and fit the storage adapter's rules", () => {
    const one = newS3Credentials();
    const two = newS3Credentials();
    expect(one.keyId).not.toBe(two.keyId);
    expect(one.secret).not.toBe(two.secret);
    expect(one.keyId).toMatch(/^[A-Za-z0-9_-]{1,128}$/u);
    expect(one.secret).toMatch(/^[\x21-\x7e]{1,128}$/u);
  });
});

describe("the bucket's identity label (S9 on the stack)", () => {
  it("is written once and refuses another institution without changing it", () => {
    ensureBucketIdentity(dir, INSTITUTION);
    const file = join(dir, S3_BUCKET, IDENTITY_KEY);
    const label = readFileSync(file, "utf8");
    expect(JSON.parse(label)).toEqual({ institutionId: INSTITUTION, region: "us-east-1" });
    ensureBucketIdentity(dir, INSTITUTION);
    expect(() => ensureBucketIdentity(dir, OTHER)).toThrow(/another institution/u);
    expect(readFileSync(file, "utf8")).toBe(label);
  });

  it("refuses a label that is a link, even to the same bytes", () => {
    const real = join(dir, "pravi.json");
    writeFileSync(real, JSON.stringify({ institutionId: INSTITUTION, region: "us-east-1" }));
    mkdirSync(join(dir, "b", S3_BUCKET), { recursive: true });
    symlinkSync(real, join(dir, "b", S3_BUCKET, IDENTITY_KEY));
    expect(() => ensureBucketIdentity(join(dir, "b"), INSTITUTION)).toThrow(/another institution/u);
  });
});

describe("the server environment of the stack", () => {
  const setup = () => {
    const seed = join(dir, "signing-seed");
    ensureSeed(seed, ROOT);
    return serverEvidenceEnv({ institutionId: INSTITUTION, seed }, 4191, newS3Credentials());
  };

  it("names exactly the evidence variables, under NODE_ENV development", () => {
    const env = setup();
    expect(Object.keys(env).sort()).toEqual([
      "DUCTUS_DEV_SIGNING_KEY_FILE",
      "EVIDENCE_S3_VS1_KEY_ID",
      "EVIDENCE_S3_VS1_SECRET",
      "EVIDENCE_STORAGE_DOMAINS",
      "NODE_ENV",
    ]);
    expect(env.NODE_ENV).toBe("development");
    // The configuration names the credential variables, never their values.
    expect(env.EVIDENCE_STORAGE_DOMAINS).not.toContain(env.EVIDENCE_S3_VS1_SECRET);
    expect(env.EVIDENCE_STORAGE_DOMAINS).not.toContain(env.EVIDENCE_S3_VS1_KEY_ID);
    const config = loadEvidenceStorageConfig(env);
    expect(config.domains.map((d) => [d.label, d.endpoint, d.bucket])).toEqual([
      ["local-demo-fakultet", "http://127.0.0.1:4191", S3_BUCKET],
    ]);
  });

  it("gives the development signer and the local S3 under development", () => {
    const deps = evidenceIngestDependencies(setup(), ROOT);
    expect(deps.signer).not.toBe(REFUSING_SIGNER);
    expect(deps.payloads).not.toBe(STORAGE_NOT_CONFIGURED);
  });

  // Contract condition 2 and P2: the same variables, seed file included, under
  // a production NODE_ENV give the refusing signer and no storage (503).
  it.each([["production"], [""], [undefined], ["Production"], [" development"], ["prod"]])(
    "under NODE_ENV %j never falls back to the development signer or the local S3",
    async (nodeEnv) => {
      const env: Record<string, string | undefined> = { ...setup(), NODE_ENV: nodeEnv };
      const deps = evidenceIngestDependencies(env, ROOT);
      expect(deps.signer).toBe(REFUSING_SIGNER);
      expect(deps.payloads).toBe(STORAGE_NOT_CONFIGURED);
      await expect(deps.signer.sign(new Uint8Array([1]))).rejects.toThrow();
    },
  );

  it("under production without storage and seed answers the same", () => {
    const deps = evidenceIngestDependencies({ NODE_ENV: "production" }, ROOT);
    expect(deps.signer).toBe(REFUSING_SIGNER);
    expect(deps.payloads).toBe(STORAGE_NOT_CONFIGURED);
  });

  // Contract condition 3 (D-09): development does not give the server a login provider.
  it("gives the server no OIDC issuer, so no fake login is configured", () => {
    const env = setup();
    expect(Object.keys(env).some((name) => /OIDC|ISSUER|AUTH/u.test(name))).toBe(false);
    expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
  });

  it("refuses a seed path inside the checkout even under development", async () => {
    const inRepo = join(ROOT, "signing-seed-test");
    const env = { ...setup(), DUCTUS_DEV_SIGNING_KEY_FILE: inRepo };
    const deps = evidenceIngestDependencies(env, ROOT);
    const signed = await deps.signer.sign(new Uint8Array([1]));
    expect(signed).toMatchObject({ ok: false, error: { code: "SIGNING_KEY_IN_REPOSITORY" } });
  });
});
