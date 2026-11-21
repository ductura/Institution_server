import { createHash } from "node:crypto";
import { canonicalizeJcs } from "../forensics/index.ts";
import {
  ATTACHMENT_REASON_ORDER,
  CONVERSATION_ATTACHMENT_REASONS,
  EXTERNAL_ATTACHMENT_REASON,
  EXTERNAL_FORMATS,
  MAX_EXTERNAL_ATTACHMENT_BYTES,
  type AttachmentReason,
  type ConversationAttachmentReason,
  type ExternalFormat,
} from "./constants.ts";
import { dataObject, isPositiveInt, isSha256Hex, isUuidV4, keySet } from "./shape.ts";

export type ConversationAttachment = {
  reason: ConversationAttachmentReason;
  conversationId: string;
  throughSeq: number;
  messagesSha256: string;
};

export type ExternalAttachment = {
  reason: typeof EXTERNAL_ATTACHMENT_REASON;
  externalAttachmentId: string;
  format: ExternalFormat;
  byteLength: number;
  contentSha256: string;
};

export type DeclarationAttachment = ConversationAttachment | ExternalAttachment;

const CONVERSATION_KEYS = keySet("reason", "conversationId", "throughSeq", "messagesSha256");
const EXTERNAL_KEYS = keySet(
  "reason",
  "externalAttachmentId",
  "format",
  "byteLength",
  "contentSha256",
);

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

export function isExternalFormat(value: unknown): value is ExternalFormat {
  return typeof value === "string" && (EXTERNAL_FORMATS as readonly string[]).includes(value);
}

export function isConversationAttachment(value: unknown): value is ConversationAttachment {
  return (
    dataObject(value, CONVERSATION_KEYS) &&
    (CONVERSATION_ATTACHMENT_REASONS as readonly unknown[]).includes(value.reason) &&
    isUuidV4(value.conversationId) &&
    isPositiveInt(value.throughSeq) &&
    isSha256Hex(value.messagesSha256)
  );
}

export function isExternalAttachment(value: unknown): value is ExternalAttachment {
  return (
    dataObject(value, EXTERNAL_KEYS) &&
    value.reason === EXTERNAL_ATTACHMENT_REASON &&
    isUuidV4(value.externalAttachmentId) &&
    isExternalFormat(value.format) &&
    isPositiveInt(value.byteLength) &&
    value.byteLength <= MAX_EXTERNAL_ATTACHMENT_BYTES &&
    isSha256Hex(value.contentSha256)
  );
}

/**
 * `messagesSha256` (section 2.1): SHA-256 of the JCS array of the messages'
 * `content_sha256`, from `seq` 1 to `throughSeq` in order. Returns null for an
 * empty list or a value that is not a SHA-256 hex digest.
 */
export function computeMessagesSha256(contentSha256s: readonly string[]): string | null {
  if (contentSha256s.length === 0 || !contentSha256s.every(isSha256Hex)) return null;
  return sha256Hex(canonicalizeJcs([...contentSha256s]));
}

const attachmentId = (a: DeclarationAttachment): string =>
  a.reason === EXTERNAL_ATTACHMENT_REASON ? a.externalAttachmentId : a.conversationId;

const reasonRank = (reason: AttachmentReason): number => ATTACHMENT_REASON_ORDER.indexOf(reason);

/** Payload order of `ai.attachments`: reason in table order, then id. */
export function compareAttachments(a: DeclarationAttachment, b: DeclarationAttachment): number {
  const byReason = reasonRank(a.reason) - reasonRank(b.reason);
  if (byReason !== 0) return byReason;
  const ia = attachmentId(a);
  const ib = attachmentId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function sortAttachments(list: readonly DeclarationAttachment[]): DeclarationAttachment[] {
  return [...list].sort(compareAttachments);
}

export type ExternalBytesCheck =
  | { ok: true; format: ExternalFormat; byteLength: number; contentSha256: string }
  | { ok: false; reason: "unsupported_media_type" | "invalid_input" };

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // "%PDF-"
const TEXT_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/u;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean =>
  bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);

/**
 * Checks the bytes of an external attachment (section 3.2) and returns its
 * payload fields. `format` is the media type without parameters; parsing the
 * `content-type` header is the route's job. The bytes are never normalised:
 * the hash is over exactly what was received.
 */
export function checkExternalAttachmentBytes(
  format: string,
  bytes: Uint8Array,
): ExternalBytesCheck {
  if (!isExternalFormat(format)) return { ok: false, reason: "unsupported_media_type" };
  if (bytes.length === 0 || bytes.length > MAX_EXTERNAL_ATTACHMENT_BYTES)
    return { ok: false, reason: "invalid_input" };
  if (format === "text/plain") {
    if (startsWith(bytes, UTF8_BOM)) return { ok: false, reason: "invalid_input" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "invalid_input" };
    }
    if (TEXT_CONTROL.test(text)) return { ok: false, reason: "invalid_input" };
  } else if (!startsWith(bytes, PDF_HEADER)) {
    return { ok: false, reason: "invalid_input" };
  }
  return { ok: true, format, byteLength: bytes.length, contentSha256: sha256Hex(bytes) };
}
