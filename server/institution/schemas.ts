// The course body of POST /api/v1/institution/courses (DAN-852-1; contract
// Ductus#1836 c.6943053415). Literal port of Ductus courseInput in
// src/server/institution/create-course.ts at 078c780fb0e53ecaa51757d4913508834a0723a1,
// with the order and form of every check kept. The only changes are of naming
// and types for this repo: the function is parseCourseBody, it is exported,
// and its result type narrows aiPolicy to the three literals the checks
// already require. The RPC (institution.create_course) judges the name further.

const POLICIES = new Set(["prohibited", "partially_allowed", "encouraged"]);

export type AiPolicy = "prohibited" | "partially_allowed" | "encouraged";
export type CourseBody = { name: string; academicYear: string; aiPolicy: AiPolicy };

// Strict API shape: identity, institution and membership are NEVER JSON inputs.
export function parseCourseBody(value: unknown): CourseBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (
    keys.length !== 3 ||
    !["name", "academicYear", "aiPolicy"].every((key) => keys.includes(key))
  ) {
    return null;
  }
  if (
    typeof obj.name !== "string" ||
    typeof obj.academicYear !== "string" ||
    typeof obj.aiPolicy !== "string"
  ) {
    return null;
  }
  if (obj.name.trim() !== obj.name || obj.name.length < 1 || obj.name.length > 160) return null;
  const years = /^([0-9]{4})\/([0-9]{4})$/.exec(obj.academicYear);
  if (!years || Number(years[2]) !== Number(years[1]) + 1) return null;
  if (!POLICIES.has(obj.aiPolicy)) return null;
  return { name: obj.name, academicYear: obj.academicYear, aiPolicy: obj.aiPolicy as AiPolicy };
}

// The enrolment code body of POST /api/v1/institution/courses/{courseId}/enrollment-code
// (DAN-852-3a; contract Ductus#1836 c.6945059378). Literal port of the body
// check and validTimestamp of Ductus src/server/institution/enrollment-code-route.ts
// at 078c780fb0e53ecaa51757d4913508834a0723a1. The only changes are of naming,
// export and form: the check is a function that returns the body or null (the
// route's 422) instead of a response; days[month - 1] carries a non-null
// assertion for noUncheckedIndexedAccess (month is already 1 to 12 there); and
// prettier wraps the lines.

export type EnrollmentCodeBody = { validUntil: string };

// Keep the caller's timestamp intact (including microseconds). Date.parse alone
// normalizes impossible dates such as February 30; reject them before the RPC.
function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) return false;
  const [, y, m, d, h, min, s, zh = "0", zm = "0"] = parts;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(h) <= 23 &&
    Number(min) <= 59 &&
    Number(s) <= 59 &&
    Number(zh) <= 15 &&
    Number(zm) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseEnrollmentCodeBody(value: unknown): EnrollmentCodeBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "validUntil") ||
    !validTimestamp(body.validUntil)
  ) {
    return null;
  }
  return { validUntil: body.validUntil };
}

// The enrolment body of POST /api/v1/institution/enrollments (DAN-853-1c).
// Literal port of validInput of Ductus src/server/institution/enrollment-route.ts
// at 078c780, in its order: Object.keys gives one key, code is own, and only
// then is code read, once: a string of at most 64
// UTF-16 units, kept unchanged (the RPC ignores spaces, hyphens and case). Two
// changes: a getter or Proxy that throws is null, where Ductus threw, and the
// one value read is the one returned, where Ductus read code again later. A
// JSON body has neither a getter nor a Proxy, so no HTTP answer changes.
export type EnrollmentBody = { code: string };

export function parseEnrollmentBody(value: unknown): EnrollmentBody | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    // The order of Ductus: count the keys, then own code, and only then read it (once).
    if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "code")) return null;
    const code = input.code;
    return typeof code === "string" && code.length <= 64 ? { code } : null;
  } catch {
    return null;
  }
}
