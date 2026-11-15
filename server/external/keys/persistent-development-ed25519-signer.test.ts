import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hasDashAndUnderscore,
  MALFORMED_SIGNATURE_SPELLINGS,
} from "../../../test-support/malformed-signatures/index.ts";
import type { AppError, Result } from "../../domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  DevelopmentSigningKeyError,
  PersistentDevelopmentEd25519SigningKeyProvider,
  developmentKeyIdentity,
} from "./persistent-development-ed25519-signer.ts";
import { DEVELOPMENT_KEY_RESULT_FAULTS, developmentKeyError } from "./signing-errors.ts";

// Invented seed bytes; no key here belongs to anyone.
const SEED = Buffer.alloc(32, 7);
const MESSAGE = new TextEncoder().encode("ductus-evidence-receipt-v2\nsynthetic");

let dir: string;
let repo: string;
const file = (name: string) => join(dir, name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ductus-dev-key-"));
  repo = join(dir, "repo");
  await mkdir(repo);
  await writeFile(file("seed"), SEED, { mode: 0o600 });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const signer = (path: string | undefined, nodeEnv = "test") =>
  new PersistentDevelopmentEd25519SigningKeyProvider(
    { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: path },
    repo,
  );

/** The value of a result the port must return as ok. */
async function ok<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

/** The error of a result the port must return as a failure (§8), never a throw. */
async function failed(promise: Promise<Result<unknown>>): Promise<AppError> {
  const result = await promise;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

/** The code of a seed fault as a result: the closed fault, upper-cased. */
async function resultFault(promise: Promise<Result<unknown>>) {
  const error = await failed(promise);
  const fault = DEVELOPMENT_KEY_RESULT_FAULTS.find((f) => f.toUpperCase() === error.code);
  expect(fault, error.code).toBeDefined();
  if (fault !== undefined) expect(developmentKeyError(fault)).toEqual(error);
  return error.code;
}

const verified = (value: boolean) => ({ ok: true, value });

describe("persistent development signer", () => {
  it("gives the same key, identity and signature from the same seed in two instances", async () => {
    const [a, b] = [signer(file("seed")), signer(file("seed"))];
    const keyA = await ok(a.publicVerificationKey());
    expect(await ok(b.publicVerificationKey())).toEqual(keyA);
    expect(await ok(b.sign(MESSAGE))).toEqual(await ok(a.sign(MESSAGE)));

    const spki = Buffer.from(keyA.keyBase64Url, "base64url");
    const fingerprint = createHash("sha256").update(spki).digest("hex");
    expect(keyA).toMatchObject({
      algorithm: "Ed25519",
      encoding: "spki-der",
      keyId: `dev-ed25519-${fingerprint.slice(0, 16)}`,
      keyVersion: `spki-sha256-${fingerprint}`,
    });
    expect(developmentKeyIdentity(spki)).toEqual({
      keyId: keyA.keyId,
      keyVersion: keyA.keyVersion,
    });
    // The canonical 44-byte SPKI the registry takes.
    expect(keyA.keyBase64Url).toMatch(/^MCowBQYDK2VwAyEA[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
  });

  it("signs what node:crypto verifies with the exported public key, and verifies its own signature only", async () => {
    const s = signer(file("seed"));
    const signature = await ok(s.sign(MESSAGE));
    const publicKey = createPublicKey({
      key: Buffer.from((await ok(s.publicVerificationKey())).keyBase64Url, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(
      nodeVerify(null, MESSAGE, publicKey, Buffer.from(signature.signatureBase64Url, "base64url")),
    ).toBe(true);
    expect(await s.verify(MESSAGE, signature)).toEqual(verified(true));
    expect(await s.verify(new TextEncoder().encode("other"), signature)).toEqual(verified(false));
    expect(await s.verify(MESSAGE, { ...signature, keyVersion: "1" })).toEqual(verified(false));
  });

  it.each(MALFORMED_SIGNATURE_SPELLINGS)(
    "answers a signature with %s as not verified",
    async (_name, spell) => {
      const s = signer(file("seed"));
      // The seed is fixed, so this finds the same signature with both - and _ every run.
      for (let i = 0; i < 1000; i += 1) {
        const message = new TextEncoder().encode(`synthetic receipt ${i}`);
        const signature = await ok(s.sign(message));
        if (!hasDashAndUnderscore(signature.signatureBase64Url)) continue;

        expect(await s.verify(message, signature)).toEqual(verified(true));
        const malformed = spell(signature.signatureBase64Url);
        expect(malformed).not.toBe(signature.signatureBase64Url);
        expect(await s.verify(message, { ...signature, signatureBase64Url: malformed })).toEqual(
          verified(false),
        );
        return;
      }
      throw new Error("no signature with both - and _ in 1000 tries");
    },
  );

  it("refuses construction in production (T9)", () => {
    expect(() => signer(file("seed"), "production")).toThrow(DevelopmentSigningKeyError);
  });

  // F-020: an allowlist, so an unset, empty or misspelt NODE_ENV is production.
  it.each([undefined, "", "Production", "production ", "staging", "prod"])(
    "refuses construction when NODE_ENV is %j",
    (nodeEnv) => {
      const construct = () =>
        new PersistentDevelopmentEd25519SigningKeyProvider(
          { NODE_ENV: nodeEnv, [DEV_SIGNING_KEY_FILE]: file("seed") },
          repo,
        );
      expect(construct).toThrow(DevelopmentSigningKeyError);
      expect(() => construct()).toThrow(
        expect.objectContaining({ code: "signing_key_production" }),
      );
    },
  );

  it.each(["development", "test"])("may be constructed when NODE_ENV is %s", (nodeEnv) => {
    expect(signer(file("seed"), nodeEnv)).toBeInstanceOf(
      PersistentDevelopmentEd25519SigningKeyProvider,
    );
  });

  it.each([
    ["no path", undefined, "signing_key_not_configured"],
    ["an empty path", "", "signing_key_not_configured"],
    ["a relative path", "seed", "signing_key_path_not_absolute"],
    ["a missing file", "missing", "signing_key_missing"],
    ["a directory", "repo", "signing_key_not_regular_file"],
    ["a short seed", "short", "signing_key_malformed"],
    ["a long seed", "long", "signing_key_malformed"],
    ["a file in the repository", "repo/seed", "signing_key_in_repository"],
    [
      "a file under a repository directory named like ..",
      "repo/..keys/seed",
      "signing_key_in_repository",
    ],
  ])("never makes a key for %s, on every call (T5)", async (_, name, code) => {
    await writeFile(file("short"), SEED.subarray(0, 31), { mode: 0o600 });
    await writeFile(file("long"), Buffer.concat([SEED, Buffer.from([0])]), { mode: 0o600 });
    await writeFile(file("repo/seed"), SEED, { mode: 0o600 });
    const path = name === undefined || name === "" || name === "seed" ? name : file(name);
    const s = signer(path);
    expect(await resultFault(s.sign(MESSAGE))).toBe(code.toUpperCase());
    expect(await resultFault(s.publicVerificationKey())).toBe(code.toUpperCase());
    // verify returns the same fault as a result, never a throw (§8).
    const envelope = await ok(signer(file("seed")).sign(MESSAGE));
    expect(await resultFault(s.verify(MESSAGE, envelope))).toBe(code.toUpperCase());
  });

  it("judges a seed under a link to the repository by where it leads, also before its directory exists", async () => {
    // A directory link; a junction on Windows, which needs no privilege.
    await symlink(repo, file("repo-link"), process.platform === "win32" ? "junction" : "dir");
    // ".." after a directory that does not exist is folded first (review465b);
    // written by hand, because join() would fold it itself.
    const behindDotDot = [dir, "not-yet", "..", "repo-link", "seed-dir", "seed"].join(sep);
    for (const path of [
      file("repo-link/not-yet/seed"),
      file("repo-link/not-yet/deeper/seed"),
      file("repo-link/seed"),
      behindDotDot,
    ]) {
      expect(await resultFault(signer(path).sign(MESSAGE))).toBe("SIGNING_KEY_IN_REPOSITORY");
    }
    // A missing directory outside the repository is only missing.
    expect(await resultFault(signer(file("not-yet/seed")).sign(MESSAGE))).toBe(
      "SIGNING_KEY_MISSING",
    );
  });

  it("names no path or key byte in a fault", async () => {
    const canary = file("canary-path-7f3a");
    const result = await signer(canary).sign(MESSAGE);
    expect(result).toEqual({ ok: false, error: developmentKeyError("signing_key_missing") });
    expect(JSON.stringify(result)).not.toContain("canary");
    // verify returns the same fault as a result; it names no path either.
    const verifiedResult = await signer(canary).verify(
      MESSAGE,
      await ok(signer(file("seed")).sign(MESSAGE)),
    );
    expect(verifiedResult).toEqual(result);
    expect(JSON.stringify(verifiedResult)).not.toContain("canary");
  });

  it("reads the file again after a fault, so a key made later is used", async () => {
    const s = signer(file("late"));
    expect(await resultFault(s.sign(MESSAGE))).toBe("SIGNING_KEY_MISSING");
    await writeFile(file("late"), SEED, { mode: 0o600 });
    expect((await ok(s.publicVerificationKey())).keyId).toBe(
      (await ok(signer(file("seed")).publicVerificationKey())).keyId,
    );
  });

  // POSIX permission bits do not mean the same on Windows, so there the seed
  // is not judged by them (known limit 1); CI runs the POSIX branch.
  it("refuses a seed others can read on POSIX", async () => {
    await writeFile(file("open"), SEED);
    await chmod(file("open"), 0o644);
    const loaded = signer(file("open")).publicVerificationKey();
    if (process.platform === "win32") {
      expect((await ok(loaded)).keyBase64Url).toBe(
        (await ok(signer(file("seed")).publicVerificationKey())).keyBase64Url,
      );
    } else {
      expect(await resultFault(loaded)).toBe("SIGNING_KEY_PERMISSIONS");
    }
  });

  it("refuses a link to a seed", async () => {
    // Creating a file link on Windows needs a privilege; a junction stands in.
    const made = await symlink(file("seed"), file("link"), "file").then(
      () => file("link"),
      async () => {
        await symlink(repo, file("junction"), "junction");
        return file("junction");
      },
    );
    expect(await resultFault(signer(made).sign(MESSAGE))).toBe("SIGNING_KEY_NOT_REGULAR_FILE");
  });
});
