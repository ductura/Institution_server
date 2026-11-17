// The course body of POST /api/v1/institution/courses (DAN-852-1; contract
// Ductus#1836 c.6943053415). Literal port of Ductus courseInput
// (src/server/institution/create-course.ts): identity, institution and
// membership are never inputs; they come only from the session. The RPC
// (institution.create_course) judges the name further (is_plain_label).

const POLICIES: ReadonlySet<string> = new Set(["prohibited", "partially_allowed", "encouraged"]);
const KEYS = ["name", "academicYear", "aiPolicy"] as const;
const MAX_NAME_UNITS = 160;

export type AiPolicy = "prohibited" | "partially_allowed" | "encouraged";
export type CourseBody = { name: string; academicYear: string; aiPolicy: AiPolicy };

/**
 * The body when it is an object of exactly the three own keys: a name of 1 to
 * 160 UTF-16 units with no white space at either end, two consecutive years
 * as YYYY/YYYY and one of the three policies; otherwise null (the route's 422).
 */
export function parseCourseBody(value: unknown): CourseBody | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) return null;
  const { name, academicYear, aiPolicy } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof academicYear !== "string") return null;
  if (typeof aiPolicy !== "string" || !POLICIES.has(aiPolicy)) return null;
  if (name.trim() !== name || name.length < 1 || name.length > MAX_NAME_UNITS) return null;
  const years = /^([0-9]{4})\/([0-9]{4})$/.exec(academicYear);
  if (years === null || Number(years[2]) !== Number(years[1]) + 1) return null;
  return { name, academicYear, aiPolicy: aiPolicy as AiPolicy };
}
