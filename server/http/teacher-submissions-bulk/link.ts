// SRV-1902 (plan P-D2): the link to the ZIP of all submissions of an
// assignment. A link names one assignment and one format and is valid for 24
// hours from the moment it was issued. It carries its expiry and a MAC over
// (assignment, format, expiry) keyed by the session token that asked for it,
// as the submission package link of SRV-1807 with its own label, so it cannot
// be moved to another assignment, format or session and its expiry cannot be
// changed. It is not the authority to read: the download still needs the live
// session and the caller's read of the assignment as its teacher (C-23).
// Nothing here reads a clock but its `now` argument.
import { createHmac, timingSafeEqual } from "node:crypto";

export const BULK_FORMATS = ["pdf", "docx"] as const;
export type BulkFormat = (typeof BULK_FORMATS)[number];

/** A link is valid for 24 hours, as the submission package of SRV-1807. */
export const BULK_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const LABEL = "ductura.teacher-submissions-bulk-link.v1";
const TOKEN = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/u;

export const isBulkFormat = (value: unknown): value is BulkFormat =>
  (BULK_FORMATS as readonly unknown[]).includes(value);

function mac(sessionToken: string, assignmentId: string, format: BulkFormat, expiresMs: number) {
  return createHmac("sha256", sessionToken)
    .update(`${LABEL}\n${assignmentId}\n${format}\n${expiresMs}`, "utf8")
    .digest("base64url");
}

export type BulkLink = { readonly token: string; readonly expiresAt: string };

/** The link issued at `nowMs` for the session `sessionToken`. */
export function issueBulkLink(
  sessionToken: string,
  assignmentId: string,
  format: BulkFormat,
  nowMs: number,
): BulkLink {
  const expiresMs = nowMs + BULK_LINK_TTL_MS;
  return {
    token: `${expiresMs}.${mac(sessionToken, assignmentId, format, expiresMs)}`,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

/** Whether `token` is this session's link for this assignment and format, and still inside its 24 hours. */
export function checkBulkLink(
  sessionToken: string,
  assignmentId: string,
  format: BulkFormat,
  token: string,
  nowMs: number,
): "valid" | "expired" | "invalid" {
  const match = TOKEN.exec(token);
  if (match === null) return "invalid";
  const expiresMs = Number(match[1]);
  if (!Number.isSafeInteger(expiresMs)) return "invalid";
  const expected = Buffer.from(mac(sessionToken, assignmentId, format, expiresMs), "utf8");
  const given = Buffer.from(match[2]!, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  return nowMs < expiresMs ? "valid" : "expired";
}
