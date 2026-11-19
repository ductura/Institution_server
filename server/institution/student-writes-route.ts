// SRV-10 (Ductus#2028 c.7008147932, A-2 and PO-7): the bodies of the
// student's two writes, student.enrollments.post ({code}) and
// student.notice-read.post ({versionNo}), read from the exact text and the
// parsed value; null is the route's 422 invalid_input. JSON.parse keeps the
// last of two equal keys, so a proxy or a log could read another value than
// the server: each body must be exactly one key, spelled plainly, which the
// text itself shows. The code is not normalised here: the RPC removes white
// space and hyphens, takes upper case and counts every refused guess
// (20261119120000), so a code of a wrong form is invalid_code, not 422.

/** At most 64 UTF-16 units, as the contract's maxLength counts. */
export const MAX_ENROLLMENT_CODE_LENGTH = 64;
const MAX_VERSION_NO = 2_147_483_647;

// Exactly {"code": <string>} with any white space around; the value's escapes are JSON's.
const CODE_TEXT = /^\s*\{\s*"code"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}\s*$/su;
// Exactly {"versionNo": <number>}; the number is checked on the parsed value.
const VERSION_TEXT = /^\s*\{\s*"versionNo"\s*:\s*-?[\d.eE+-]+\s*\}\s*$/u;

export type StudentEnrollmentBody = { code: string };
export type NoticeReadBody = { versionNo: number };

/** {code} from the request's text and parsed value, or null (422 invalid_input). */
export function parseStudentEnrollmentBody(
  text: string,
  value: unknown,
): StudentEnrollmentBody | null {
  if (!CODE_TEXT.test(text) || !value || typeof value !== "object") return null;
  const code: unknown = (value as Record<string, unknown>).code;
  if (typeof code !== "string" || code.length > MAX_ENROLLMENT_CODE_LENGTH) return null;
  return { code };
}

/** {versionNo} from the request's text and parsed value, or null (422 invalid_input). */
export function parseNoticeReadBody(text: string, value: unknown): NoticeReadBody | null {
  if (!VERSION_TEXT.test(text) || !value || typeof value !== "object") return null;
  const versionNo: unknown = (value as Record<string, unknown>).versionNo;
  if (!Number.isInteger(versionNo)) return null;
  const n = versionNo as number;
  return n >= 1 && n <= MAX_VERSION_NO ? { versionNo: n } : null;
}
