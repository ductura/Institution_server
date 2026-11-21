import { createHash, randomUUID } from "node:crypto";

import {
  createWorkAttachments,
  type WithActor,
  type WorkAttachment,
  type WorkAttachmentAdd,
  WORK_ATTACHMENT_MAX_BYTES,
} from "../../database/index.ts";

import { imageDetails } from "./image.ts";
import type { AttachmentStorage } from "./storage.ts";

type AddRefusal = Exclude<WorkAttachmentAdd, { status: "added" }>;
class Refused extends Error {
  readonly result: AddRefusal;

  constructor(result: AddRefusal) {
    super(result.status);
    this.result = result;
  }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function attachmentFields(record: WorkAttachment) {
  return {
    attachmentId: record.id,
    attachmentSha256: record.sha256,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    pixelWidth: record.pixelWidth,
    pixelHeight: record.pixelHeight,
  };
}

export function createAttachments(withActor: WithActor, storage: AttachmentStorage) {
  const attachments = createWorkAttachments(withActor);

  async function verifiedBytes(attachment: WorkAttachment): Promise<Buffer> {
    const bytes = await storage.read(attachment.storageRef);
    if (bytes.length !== attachment.byteSize || sha256(bytes) !== attachment.sha256) {
      throw new Error("attachment bytes do not match their record");
    }
    return bytes;
  }

  return {
    async upload(token: string, assignmentId: string, imageBase64: string) {
      const bytes = Buffer.from(imageBase64, "base64");
      if (bytes.length > WORK_ATTACHMENT_MAX_BYTES) return { status: "body_too_large" } as const;
      const image = imageDetails(bytes);
      if (image === undefined || bytes.toString("base64") !== imageBase64) {
        return { status: "invalid_input" } as const;
      }
      try {
        return await withActor(token, async (tx) => {
          // The RPC checks access and quota before touching storage. Keep the same
          // transaction open until the bytes exist so an I/O error rolls back the row.
          const result = await createWorkAttachments((_token, run) => run(tx)).add(token, {
            assignmentId,
            ...image,
            byteSize: bytes.length,
            sha256: sha256(bytes),
            storageRef: randomUUID(),
          });
          if (result.status !== "added") throw new Refused(result);
          const { attachment, created } = result;
          if (created) await storage.put(attachment.storageRef, bytes);
          else await verifiedBytes(attachment);
          return { status: "ok", body: { ...attachmentFields(attachment), created } } as const;
        });
      } catch (error) {
        if (error instanceof Refused) return error.result;
        throw error;
      }
    },
    async read(token: string, attachmentId: string) {
      const result = await attachments.read(token, attachmentId);
      if (result.status !== "read") return result;
      const bytes = await verifiedBytes(result.attachment);
      return {
        status: "ok",
        body: { ...attachmentFields(result.attachment), imageBase64: bytes.toString("base64") },
      } as const;
    },
  };
}
