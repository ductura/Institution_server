// SRV-1308: the storage of the student data export packages, keyed by export
// id; the job of server/privacy/student-data-export writes through the same
// adapter (its port StudentDataExportStorage), the download reads and removes.
// The local adapter writes one file per export in a private directory
// (DUCTURA_STUDENT_DATA_EXPORT_DIRECTORY; under .local in development and
// test): a write goes to a temporary file first and replaces the package in
// one rename, so a reader never sees half a package and the job may write the
// same package again after a crash.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type StudentDataExportStorage = {
  put(exportId: string, bytes: Uint8Array): Promise<void>;
  read(exportId: string): Promise<Uint8Array>;
  /** Removes the package; a missing one is no error. */
  remove(exportId: string): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The directory of the packages, or "" when none is configured outside development and test. */
export function studentDataExportDirectory(env: NodeJS.ProcessEnv, root: string): string {
  const local = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  return (
    env.DUCTURA_STUDENT_DATA_EXPORT_DIRECTORY ??
    (local ? join(root, ".local", "student-data-exports") : "")
  );
}

export function studentDataExportStorage(directory: string): StudentDataExportStorage {
  const pathFor = (exportId: string): string => {
    if (!isAbsolute(directory) || !UUID.test(exportId)) {
      throw new Error("student data export storage unavailable");
    }
    return join(directory, `${exportId}.zip`);
  };
  return {
    async put(exportId, bytes) {
      const target = pathFor(exportId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async read(exportId) {
      return new Uint8Array(await readFile(pathFor(exportId)));
    },
    async remove(exportId) {
      await rm(pathFor(exportId), { force: true });
    },
  };
}

/** The SHA-256 of a link token as the database keeps it: its UTF-8 bytes (as the job hashes it). */
export function linkTokenHash(token: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(token, "utf8").digest());
}
