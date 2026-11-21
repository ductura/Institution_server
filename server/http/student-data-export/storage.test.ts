// SRV-1308: the package storage replaces a package whole, reads it back and
// removes it; an id that is not a UUID or a relative directory is refused;
// the link token hash is the SHA-256 of its UTF-8 bytes, as the database
// keeps it (184-student-data-export.sql) and the job makes it.
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { linkTokenHash, studentDataExportDirectory, studentDataExportStorage } from "./storage.ts";

const EXPORT_A = "11111111-1111-4111-8111-111111111111";

describe("studentDataExportStorage", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("replaces a package whole, reads it back and removes it", async () => {
    directory = await mkdtemp(join(tmpdir(), "izvoz-"));
    const storage = studentDataExportStorage(directory);
    await storage.put(EXPORT_A, new Uint8Array([1, 2, 3]));
    await storage.put(EXPORT_A, new Uint8Array([4, 5]));
    expect([...(await storage.read(EXPORT_A))]).toEqual([4, 5]);
    expect(await readdir(directory)).toEqual([`${EXPORT_A}.zip`]);
    await storage.remove(EXPORT_A);
    await storage.remove(EXPORT_A);
    await expect(storage.read(EXPORT_A)).rejects.toThrow();
  });

  it("refuses an id that is not a UUID and a relative directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "izvoz-"));
    await expect(
      studentDataExportStorage(directory).put("../x", new Uint8Array()),
    ).rejects.toThrow();
    await expect(studentDataExportStorage("relativno").read(EXPORT_A)).rejects.toThrow();
  });

  it("has no directory outside development and test unless one is configured", () => {
    expect(studentDataExportDirectory({ NODE_ENV: "production" }, "/srv")).toBe("");
    expect(studentDataExportDirectory({ NODE_ENV: "test" }, "/srv")).toBe(
      "/srv/.local/student-data-exports",
    );
    expect(
      studentDataExportDirectory(
        Object.fromEntries([
          ["NODE_ENV", "production"],
          ["DUCTURA_STUDENT_DATA_EXPORT_DIRECTORY", "/data/izvoz"],
        ]),
        "/srv",
      ),
    ).toBe("/data/izvoz");
  });
});

describe("linkTokenHash", () => {
  it("is the SHA-256 of the token's UTF-8 bytes", () => {
    const token = "IzmisljeniTokenPoveznice0123456789abcdefghi";
    expect(Buffer.from(linkTokenHash(token)).toString("hex")).toBe(
      createHash("sha256").update(Buffer.from(token, "utf8")).digest("hex"),
    );
  });
});
