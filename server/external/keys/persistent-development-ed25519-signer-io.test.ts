// I/O faults of the opened seed file (QA cxcqs27 and review cxcrs27 on
// a6ffc405): EIO, EACCES and the like on stat, readFile or close come out of
// every port method as SIGNING_KEY_UNREADABLE (docs/CODE_STYLE.md §8), never
// as a rejected Promise. The faults are injected through `open`, so this
// file mocks node:fs/promises; the real file system is used otherwise.
import type { FileHandle } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Result } from "../../domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
} from "./persistent-development-ed25519-signer.ts";
import { developmentKeyError } from "./signing-errors.ts";

type Step = "stat" | "readFile" | "close";

const injected = vi.hoisted(() => ({
  fault: null as null | { step: "stat" | "readFile" | "close"; code: string },
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    const fault = injected.fault;
    if (fault === null) return handle;
    const failing = async () => {
      // The real descriptor is still released, so the test leaks nothing.
      await handle.close().catch(() => undefined);
      throw Object.assign(new Error(`${fault.code}: injected`), { code: fault.code });
    };
    return new Proxy(handle, {
      get(target, property, receiver) {
        if (property === fault.step) return failing;
        if (property === "close" && fault.step !== "close") {
          // Closed already by `failing` when the fault came earlier.
          return async () => {
            await target.close().catch(() => undefined);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FileHandle;
  };
  return { ...actual, open };
});

// Invented seed bytes; no key here belongs to anyone.
const SEED = Buffer.alloc(32, 7);
const MESSAGE = new TextEncoder().encode("ductus-evidence-receipt-v2\nsynthetic");
const UNREADABLE = { ok: false, error: developmentKeyError("signing_key_unreadable") };

let dir: string;
let repo: string;
let seedPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ductus-dev-key-io-"));
  repo = join(dir, "repo");
  await mkdir(repo);
  seedPath = join(dir, "seed");
  await writeFile(seedPath, SEED, { mode: 0o600 });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  injected.fault = null;
});

const signer = () =>
  new PersistentDevelopmentEd25519SigningKeyProvider(
    { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: seedPath },
    repo,
  );

async function ok<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}`);
  return result.value;
}

describe("persistent development signer, I/O faults of the seed file", () => {
  const cases: Array<[Step, string]> = [
    ["stat", "EIO"],
    ["stat", "EACCES"],
    ["readFile", "EIO"],
    ["readFile", "EACCES"],
    ["close", "EIO"],
  ];

  it.each(cases)(
    "returns SIGNING_KEY_UNREADABLE from sign, publicVerificationKey and verify when %s fails with %s",
    async (step, code) => {
      const envelope = await ok(signer().sign(MESSAGE));
      injected.fault = { step, code };
      const s = signer();
      await expect(s.sign(MESSAGE)).resolves.toEqual(UNREADABLE);
      await expect(s.publicVerificationKey()).resolves.toEqual(UNREADABLE);
      await expect(s.verify(MESSAGE, envelope)).resolves.toEqual(UNREADABLE);
      // The result names no path and no system message.
      const result = JSON.stringify(await s.sign(MESSAGE));
      expect(result).not.toContain(dir);
      expect(result).not.toContain(code);
    },
  );

  it("keeps no fault, so the seed is read again once the file system recovers", async () => {
    const s = signer();
    injected.fault = { step: "readFile", code: "EIO" };
    await expect(s.publicVerificationKey()).resolves.toEqual(UNREADABLE);
    injected.fault = null;
    const key = await ok(s.publicVerificationKey());
    expect(key).toEqual(await ok(signer().publicVerificationKey()));
    const envelope = await ok(s.sign(MESSAGE));
    await expect(s.verify(MESSAGE, envelope)).resolves.toEqual({ ok: true, value: true });
  });

  it("returns an earlier closed fault, not the close fault after it", async () => {
    // A seed others can read fails on its mode before close fails; the
    // reported code is the mode, which is what the owner must fix.
    const open = join(dir, "open");
    await writeFile(open, SEED, { mode: 0o644 });
    injected.fault = { step: "close", code: "EIO" };
    const s = new PersistentDevelopmentEd25519SigningKeyProvider(
      { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: open },
      repo,
    );
    const expected =
      process.platform === "win32"
        ? UNREADABLE
        : { ok: false, error: developmentKeyError("signing_key_permissions") };
    await expect(s.sign(MESSAGE)).resolves.toEqual(expected);
  });
});
