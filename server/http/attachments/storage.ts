import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type AttachmentStorage = {
  put(ref: string, bytes: Buffer): Promise<void>;
  read(ref: string): Promise<Buffer>;
};

export function attachmentStorage(env: NodeJS.ProcessEnv, root: string): AttachmentStorage {
  const local = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const directory =
    env.DUCTURA_ATTACHMENT_DIRECTORY ?? (local ? join(root, ".local", "attachments") : "");
  const pathFor = (ref: string): string => {
    if (!isAbsolute(directory) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(ref)) {
      throw new Error("attachment storage unavailable");
    }
    return join(directory, ref);
  };
  return {
    async put(ref, bytes) {
      const target = pathFor(ref);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
        await link(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
    read: (ref) => readFile(pathFor(ref)),
  };
}
