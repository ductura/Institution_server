// SRV-1807 (plan M8.6, R-05, R-06, D-173): the link to a submission package.
// A link names one submission and one kind and is valid for 24 hours from the
// moment it was issued. It carries its expiry and a MAC over
// (submission, kind, expiry), keyed by the session token that asked for it, so
// it cannot be moved to another submission, another kind or another session,
// and an expiry cannot be changed without the key. It is not the authority to
// read: the download route still needs the live session and the owner's own
// read of the submission (C-23). The MAC is therefore integrity of the 24 hour
// window for the caller's own session, not a bearer capability; a link that
// outlives the session (for the registrar, D-271 MQ02) needs stored state and
// is M10.5. Nothing here reads a clock but its `now` argument.
import { createHmac, timingSafeEqual } from "node:crypto";

export const PACKAGE_KINDS = ["package", "referada"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

/** A link is valid for 24 hours (M8.6 acceptance 3). */
export const PACKAGE_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const LABEL = "ductura.submission-package-link.v1";
const TOKEN = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/u;

function mac(sessionToken: string, submissionId: string, kind: PackageKind, expiresMs: number) {
  return createHmac("sha256", sessionToken)
    .update(`${LABEL}\n${submissionId}\n${kind}\n${expiresMs}`, "utf8")
    .digest("base64url");
}

export type PackageLink = {
  readonly kind: PackageKind;
  /** The link token, to be given back to the download path. */
  readonly token: string;
  /** ISO 8601 UTC with milliseconds. */
  readonly expiresAt: string;
};

/** The link issued at `nowMs` for the session `sessionToken`. */
export function issuePackageLink(
  sessionToken: string,
  submissionId: string,
  kind: PackageKind,
  nowMs: number,
): PackageLink {
  const expiresMs = nowMs + PACKAGE_LINK_TTL_MS;
  return {
    kind,
    token: `${expiresMs}.${mac(sessionToken, submissionId, kind, expiresMs)}`,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

export type PackageLinkCheck = "valid" | "expired" | "invalid";

/** Whether `token` is this session's link for this submission and kind, and still inside its 24 hours. */
export function checkPackageLink(
  sessionToken: string,
  submissionId: string,
  kind: PackageKind,
  token: string,
  nowMs: number,
): PackageLinkCheck {
  const match = TOKEN.exec(token);
  if (match === null) return "invalid";
  const expiresMs = Number(match[1]);
  if (!Number.isSafeInteger(expiresMs)) return "invalid";
  const expected = Buffer.from(mac(sessionToken, submissionId, kind, expiresMs), "utf8");
  const given = Buffer.from(match[2]!, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  return nowMs < expiresMs ? "valid" : "expired";
}
