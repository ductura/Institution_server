/**
 * The effective AI policy of one assistant request (Ductus
 * docs/contracts/ai-request-v1.md, "Politika"; plan #1662 P2 to P5, P9).
 *
 * The course rule decides: a new course takes the faculty rule as its
 * default, and the teacher may make it stricter or looser (D-175). The
 * assignment version in force may only narrow the course rule (D-52), and the
 * request never widens anything. The faculty rule is therefore not a level of
 * its own: a faculty `prohibited` with a course that allows still passes, and
 * a course `prohibited` refuses whatever the faculty says.
 *
 * A purpose passes only if it is in the assignment's `ai_purposes` and exists
 * in the assignment's catalogue version (`parsePurpose`). A level 2 purpose
 * is never on by default: it passes only when the teacher listed it on that
 * assignment (D-64, D-268 O2). Transcription also needs the institution switch
 * (#1664, P9), which is off by default. Pure: the database applies the same
 * rule inside the reservation transaction (step 3).
 */
import { parsePurpose, type PurposeEntry } from "./purpose-catalog.ts";

/** From narrowest to widest, as `institution.ai_policy_rank` (D-52). */
export const AI_POLICIES = Object.freeze([
  "prohibited",
  "partially_allowed",
  "encouraged",
] as const);
export type AiPolicy = (typeof AI_POLICIES)[number];

/** Purposes that also need the institution switch for transcription and tools. */
export const SWITCHED_PURPOSES: readonly string[] = Object.freeze(["transcription"]);

export type PolicyInput = {
  /** Only the default a new course started from; never refuses (D-175). */
  readonly faculty?: { readonly aiPolicy: AiPolicy } | undefined;
  readonly course: { readonly aiPolicy: AiPolicy };
  /** The assignment version in force when the request arrives. */
  readonly assignmentVersion: {
    readonly aiPolicy: AiPolicy;
    readonly aiPurposes: readonly string[];
    readonly purposeCatalogVersion: number;
  };
  readonly institution: { readonly transcriptionAndToolsEnabled: boolean };
  readonly request: { readonly purposeCatalogVersion: number; readonly purposeKey: string };
};

export type PolicyRule =
  | "policy_invalid"
  | "policy_prohibited"
  | "catalog_version_mismatch"
  | "purpose_unknown"
  | "purpose_not_in_assignment"
  | "level_2_not_enabled"
  | "institution_switch_off";

export type PolicyDecision =
  | { readonly ok: true; readonly effectivePolicy: AiPolicy; readonly purpose: PurposeEntry }
  | { readonly ok: false; readonly outcome: "purpose_not_allowed"; readonly rule: PolicyRule };

function rank(policy: unknown): number {
  return typeof policy === "string" ? (AI_POLICIES as readonly string[]).indexOf(policy) : -1;
}

function refuse(rule: PolicyRule): PolicyDecision {
  return { ok: false, outcome: "purpose_not_allowed", rule };
}

/** The narrower of the course and assignment rules, or null for an unknown value. */
export function effectiveAiPolicy(course: unknown, assignment: unknown): AiPolicy | null {
  const courseRank = rank(course);
  const assignmentRank = rank(assignment);
  if (courseRank < 0 || assignmentRank < 0) return null;
  return AI_POLICIES[Math.min(courseRank, assignmentRank)] ?? null;
}

export function decidePolicy(input: PolicyInput): PolicyDecision {
  const { course, assignmentVersion: version, institution, request } = input;
  const policy = effectiveAiPolicy(course.aiPolicy, version.aiPolicy);
  if (policy === null) return refuse("policy_invalid");
  if (policy === "prohibited") return refuse("policy_prohibited");
  if (request.purposeCatalogVersion !== version.purposeCatalogVersion) {
    return refuse("catalog_version_mismatch");
  }
  const parsed = parsePurpose(version.purposeCatalogVersion, request.purposeKey);
  if (!parsed.ok) return refuse("purpose_unknown");
  if (!version.aiPurposes.includes(parsed.purpose.key)) {
    return refuse(parsed.purpose.level === 2 ? "level_2_not_enabled" : "purpose_not_in_assignment");
  }
  if (
    SWITCHED_PURPOSES.includes(parsed.purpose.key) &&
    institution.transcriptionAndToolsEnabled !== true
  ) {
    return refuse("institution_switch_off");
  }
  return { ok: true, effectivePolicy: policy, purpose: parsed.purpose };
}
