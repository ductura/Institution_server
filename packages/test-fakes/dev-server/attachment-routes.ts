// Work image attachments on the dev fake server (work.attachments.post and
// work.attachments.get, SRV-10C): the student uploads a PNG or JPEG of an own
// assignment in Base64, the student and the teachers of its course read it
// back. The type is told from the file signature, never from the claim of the
// client. The real rules are the SRV-10B functions and server/http/attachments.
import { createHash } from "node:crypto";

import type { Handlers } from "./server.ts";
import { courseOfWork, courseTeachers } from "./state.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mediaTypeOf(bytes: Buffer): "image/png" | "image/jpeg" | null {
  if (bytes.length > PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/** The nth attachment id (the fake counts, so a scenario can name the first). */
const idOf = (n: number): string => `00000000-0000-4000-8000-a${String(n).padStart(11, "0")}`;

export const ATTACHMENT_HANDLERS: Handlers = {
  "work.attachments.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find(
      (w) => w.assignmentId === params.assignmentId.toLowerCase() && w.studentId === account.id,
    );
    if (work === undefined) return { error: "not_found" };
    const bytes = Buffer.from(body.imageBase64, "base64");
    const mediaType = mediaTypeOf(bytes);
    if (mediaType === null || bytes.length > MAX_BYTES) return { error: "invalid_input" };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const old = state.attachments.find(
      (a) => a.documentId === work.documentId && a.sha256 === sha256,
    );
    const attachment = old ?? {
      id: idOf(state.attachments.length + 1),
      documentId: work.documentId,
      sha256,
      mediaType,
      bytes,
    };
    if (old === undefined) state.attachments.push(attachment);
    return {
      status: 200,
      headers: { "cache-control": "private, no-store" },
      body: {
        attachmentId: attachment.id,
        attachmentSha256: sha256,
        mediaType,
        byteSize: bytes.length,
        pixelWidth: null,
        pixelHeight: null,
        created: old === undefined,
      },
    };
  },
  "work.attachments.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const attachment = state.attachments.find((a) => a.id === params.attachmentId);
    const work = state.works.find((w) => w.documentId === attachment?.documentId);
    if (attachment === undefined || work === undefined) return { error: "not_found" };
    const course = courseOfWork(state, work);
    const allowed =
      work.studentId === account.id ||
      (course !== undefined && courseTeachers(course).includes(account.id));
    if (!allowed) return { error: "not_found" };
    return {
      status: 200,
      headers: { "cache-control": "private, no-store" },
      body: {
        attachmentId: attachment.id,
        attachmentSha256: attachment.sha256,
        mediaType: attachment.mediaType,
        byteSize: attachment.bytes.length,
        pixelWidth: null,
        pixelHeight: null,
        imageBase64: attachment.bytes.toString("base64"),
      },
    };
  },
};
