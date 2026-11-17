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
