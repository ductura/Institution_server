// The body of POST /api/v1/institution/assignments/{assignmentId}/acknowledgment
// (contract institution.acknowledgment.post). Literal port of validInput,
// FINGERPRINT and singleKeys of Ductus
// src/server/institution/acknowledgment-route.ts at 078c780 (DAN-306 #1502),
// in their order; the only change is of form: one function over the decoded
// text and the parsed value that returns the body or null (the route's 422).

/**
 * The notice template the server acknowledges against: the value of
 * NOTICE_TEMPLATE_VERSION in server/domain/notice/fingerprint.ts (Ductus
 * src/domain/notice/fingerprint.ts), held equal to it by
 * acknowledgment-body.test.ts until that copied file loads here.
 */
export const NOTICE_TEMPLATE_VERSION = 1;

export type AcknowledgmentBody = { versionNo: number; fingerprint: string };

// The fingerprint of the notice the browser showed, as noticeFingerprint()
// writes it. Nothing is normalised: another spelling of the same digest is
// refused, not repaired.
const FINGERPRINT = /^[0-9a-f]{64}$/;

function validInput(value: unknown): value is AcknowledgmentBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).length === 2 &&
    Object.hasOwn(input, "versionNo") &&
    Object.hasOwn(input, "fingerprint") &&
    Number.isInteger(input.versionNo) &&
    (input.versionNo as number) >= 1 &&
    (input.versionNo as number) <= 2_147_483_647 &&
    typeof input.fingerprint === "string" &&
    FINGERPRINT.test(input.fingerprint)
  );
}

// JSON.parse keeps the last of two equal keys, so {"fingerprint":A,
// "fingerprint":B} would be read as B while a proxy or log reads A. A valid
// body has two keys, two plain string keys and one string value: exactly six
// quotes and no escape, so neither a repeat nor an escaped spelling of a key
// (fingerprint) gets through. A strict rule for this body alone.
function singleKeys(text: string): boolean {
  return !text.includes("\\") && text.split('"').length === 7;
}

/** The body from its exact text and its parsed value, or null (422 invalid_input). */
export function parseAcknowledgmentBody(text: string, value: unknown): AcknowledgmentBody | null {
  if (!singleKeys(text) || !validInput(value)) return null;
  return { versionNo: value.versionNo, fingerprint: value.fingerprint };
}
