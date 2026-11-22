import type { WithActor } from "../database/with-actor.ts";

/**
 * DAN-590 (M2.12-P03, screen A-04; contract on #1091, c.6695058963): the
 * faculty rule versions of the administrator's own institution, read only.
 * One statement in a withActor transaction: whether the session is open
 * (app.current_actor(), 401 when it is not) and institution.actor_has_role('admin'),
 * so an institution without versions is told apart from a caller who may not
 * see them (notFound, as for a route that does not exist), joined with the
 * versions read through the faculty_rule_version_read policy (DAN-315). One
 * statement is one snapshot under READ COMMITTED (the functions are STABLE),
 * so a role revoked between two statements cannot read as an empty list. The
 * institution comes only from the session. Any row the table's CHECKs would refuse, or a
 * chain that is not 1..n per work type, makes the read unavailable, never a
 * partial list.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

export const WORK_TYPES = [
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
] as const;
export const AI_POLICIES = ["prohibited", "partially_allowed", "encouraged"] as const;
export const AI_PURPOSES = [
  "formatting",
  "proofreading",
  "literature_search",
  "transcription",
  "translation",
] as const;
const EVIDENCE_PROFILES = ["basic", "extended"] as const;
const ORIGINS = ["operator", "administrator"] as const;

export type WorkType = (typeof WORK_TYPES)[number];
export type AiPolicy = (typeof AI_POLICIES)[number];
export type AiPurpose = (typeof AI_PURPOSES)[number];

export type FacultyRuleVersion = {
  versionNo: number;
  aiPolicy: AiPolicy;
  aiPurposes: AiPurpose[];
  evidenceProfile: (typeof EVIDENCE_PROFILES)[number];
  importAllowed: boolean;
  /** "operator": converted from the rule before versions; "administrator": published in the application. */
  origin: (typeof ORIGINS)[number];
  /** ISO time of publication. */
  publishedAt: string;
};

/** Every work type in WORK_TYPES order; versions ascending, empty when none is published. */
export type FacultyRules = { workType: WorkType; versions: FacultyRuleVersion[] }[];

export type FacultyRulesRead =
  { kind: "ok"; rules: FacultyRules } | { kind: "unauthorized" | "notFound" | "unavailable" };

type Row = Record<string, unknown>;

// The role row always comes back; versions join it only when it is true. A
// session that is not open (closed by logout, expired) is not an actor, so
// authenticated is false and the answer is 401 before the role is asked, as on
// the other routes (ZEL-S10).
const QUERY = `SELECT (SELECT a.user_id FROM app.current_actor() a) IS NOT NULL AS authenticated,
    r.admin, v.work_type, v.version_no, v.ai_policy, v.ai_purposes, v.evidence_profile,
    v.import_allowed, v.origin, v.published_at
  FROM (SELECT institution.actor_has_role('admin') AS admin) r
  LEFT JOIN institution.faculty_rule_version v ON r.admin IS TRUE
  ORDER BY v.work_type, v.version_no`;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

function purposesOf(value: unknown, policy: AiPolicy): AiPurpose[] | null {
  if (!Array.isArray(value) || value.length > AI_PURPOSES.length) return null;
  if (
    !value.every((purpose) => oneOf(AI_PURPOSES, purpose)) ||
    new Set(value).size !== value.length
  )
    return null;
  return policy === "prohibited" && value.length > 0 ? null : (value as AiPurpose[]);
}

function versionOf(row: Row): { workType: WorkType; version: FacultyRuleVersion } | null {
  const {
    work_type: workType,
    version_no: versionNo,
    ai_policy: aiPolicy,
    evidence_profile: evidenceProfile,
    import_allowed: importAllowed,
    origin,
    published_at: publishedAt,
  } = row;
  if (
    !oneOf(WORK_TYPES, workType) ||
    !oneOf(AI_POLICIES, aiPolicy) ||
    !oneOf(EVIDENCE_PROFILES, evidenceProfile) ||
    !oneOf(ORIGINS, origin) ||
    typeof importAllowed !== "boolean"
  )
    return null;
  if (typeof versionNo !== "number" || !Number.isSafeInteger(versionNo) || versionNo < 1)
    return null;
  if (!(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime())) return null;
  const aiPurposes = purposesOf(row.ai_purposes, aiPolicy);
  if (aiPurposes === null) return null;
  return {
    workType,
    version: {
      versionNo,
      aiPolicy,
      aiPurposes,
      evidenceProfile,
      importAllowed,
      origin,
      publishedAt: publishedAt.toISOString(),
    },
  };
}

/** The rows as rules per work type, or null when any row or chain is not what the table holds. */
export function facultyRulesOf(rows: readonly Row[]): FacultyRules | null {
  const rules: FacultyRules = WORK_TYPES.map((workType) => ({ workType, versions: [] }));
  for (const row of rows) {
    const parsed = versionOf(row);
    if (parsed === null) return null;
    const chain = rules.find((rule) => rule.workType === parsed.workType)!.versions;
    // Version n follows n - 1: no gap, duplicate or reordering.
    if (parsed.version.versionNo !== chain.length + 1) return null;
    chain.push(parsed.version);
  }
  return rules;
}

/** The administrator's rows: one row without a version when none is published. */
function versionsOf(rows: readonly Row[]): FacultyRules | null {
  if (rows.length === 1 && rows[0]!.work_type === null) return facultyRulesOf([]);
  return facultyRulesOf(rows);
}

function codeOf(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

export async function readFacultyRules(
  sessionToken: string | undefined,
  withActor: WithActor,
): Promise<FacultyRulesRead> {
  if (sessionToken === undefined || !TOKEN.test(sessionToken)) return { kind: "unauthorized" };
  let rows: Row[];
  try {
    rows = await withActor(sessionToken, async (tx) => (await tx.query<Row>(QUERY)).rows);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ZD401") return { kind: "unauthorized" };
    if (code === "ZD403") return { kind: "notFound" };
    console.error(
      "faculty rules read failed",
      code !== undefined && SQLSTATE.test(code) ? code : "unknown",
    );
    return { kind: "unavailable" };
  }
  const first = rows.length === 1 ? rows[0]! : undefined;
  if (first?.authenticated === false && first.admin === false) return { kind: "unauthorized" };
  const admin = rows.length > 0 ? rows[0]!.admin : undefined;
  const signedIn = rows.every((row) => row.authenticated === true);
  if (signedIn && admin === false && rows.length === 1) return { kind: "notFound" };
  const rules =
    signedIn && admin === true && rows.every((row) => row.admin === true) ? versionsOf(rows) : null;
  if (rules === null) {
    console.error("faculty rules read failed", "row_malformed");
    return { kind: "unavailable" };
  }
  return { kind: "ok", rules };
}

/** The body a publication carries; the institution, the author and the time come from the session. */
export type FacultyRuleInput = {
  workType: WorkType;
  /** The latest version the administrator saw, null when none was published. */
  basedOnVersionNo: number | null;
  aiPolicy: AiPolicy;
  aiPurposes: AiPurpose[];
  evidenceProfile: (typeof EVIDENCE_PROFILES)[number];
  importAllowed: boolean;
};

export type FacultyRulePublication =
  | { kind: "ok"; versionNo: number; publishedAt: string }
  | {
      kind: "unauthorized" | "forbidden" | "conflict" | "invalid" | "unavailable";
    };

/** The 422 code that names the field a body is refused for. */
export type FacultyRuleRefusal =
  | "invalid_input"
  | "invalid_work_type"
  | "invalid_ai_policy"
  | "invalid_ai_purposes"
  | "invalid_evidence_profile";

const INPUT_KEYS = [
  "workType",
  "basedOnVersionNo",
  "aiPolicy",
  "aiPurposes",
  "evidenceProfile",
  "importAllowed",
] as const;

/**
 * Why a decoded body is not a publication, as the code the field is refused
 * with, or null when it is one. A wrong shape (a key missing or added, a
 * number or boolean of the wrong type) is invalid_input; a value outside the
 * closed list of its field names that field; purposes that repeat or come
 * with the policy prohibited are invalid_ai_purposes.
 */
export function facultyRuleRefusal(value: unknown): FacultyRuleRefusal | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid_input";
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== INPUT_KEYS.length || !INPUT_KEYS.every((key) => keys.includes(key)))
    return "invalid_input";
  const based = body.basedOnVersionNo;
  if (
    based !== null &&
    (typeof based !== "number" ||
      !Number.isSafeInteger(based) ||
      based < 1 ||
      based > 2_147_483_647)
  )
    return "invalid_input";
  if (typeof body.importAllowed !== "boolean") return "invalid_input";
  if (!oneOf(WORK_TYPES, body.workType)) return "invalid_work_type";
  if (!oneOf(AI_POLICIES, body.aiPolicy)) return "invalid_ai_policy";
  if (!oneOf(EVIDENCE_PROFILES, body.evidenceProfile)) return "invalid_evidence_profile";
  return purposesOf(body.aiPurposes, body.aiPolicy) === null ? "invalid_ai_purposes" : null;
}

/**
 * Publishes the next version of one work type for the administrator of the
 * session: the RPC publish_faculty_rule_version (DAN-315) decides who may,
 * whether the expected version is the latest (409) and the content (422); the
 * time is read back in the same transaction, after the insert it follows.
 */
export async function publishFacultyRule(
  sessionToken: string | undefined,
  input: FacultyRuleInput,
  withActor: WithActor,
): Promise<FacultyRulePublication> {
  if (sessionToken === undefined || !TOKEN.test(sessionToken)) return { kind: "unauthorized" };
  let row: Row | undefined;
  try {
    row = await withActor(sessionToken, async (tx) => {
      const published = (
        await tx.query<Row>(
          "SELECT institution.publish_faculty_rule_version($1, $2, $3, $4::text[], $5, $6) AS version_no",
          [
            input.workType,
            input.basedOnVersionNo ?? 0,
            input.aiPolicy,
            input.aiPurposes,
            input.evidenceProfile,
            input.importAllowed,
          ],
        )
      ).rows[0];
      const versionNo = published?.version_no;
      if (typeof versionNo !== "number") return undefined;
      return (
        await tx.query<Row>(
          `SELECT version_no, published_at FROM institution.faculty_rule_version
            WHERE work_type = $1 AND version_no = $2`,
          [input.workType, versionNo],
        )
      ).rows[0];
    });
  } catch (error) {
    const code = codeOf(error);
    if (code === "ZD401") return { kind: "unauthorized" };
    if (code === "ZD403") return { kind: "forbidden" };
    if (code === "ZD409") return { kind: "conflict" };
    if (code === "ZD422") return { kind: "invalid" };
    console.error(
      "faculty rule publication failed",
      code !== undefined && SQLSTATE.test(code) ? code : "unknown",
    );
    return { kind: "unavailable" };
  }
  const versionNo = row?.version_no;
  const publishedAt = row?.published_at;
  if (
    typeof versionNo !== "number" ||
    !Number.isSafeInteger(versionNo) ||
    versionNo < 1 ||
    !(publishedAt instanceof Date) ||
    !Number.isFinite(publishedAt.getTime())
  ) {
    console.error("faculty rule publication failed", "row_malformed");
    return { kind: "unavailable" };
  }
  return { kind: "ok", versionNo, publishedAt: publishedAt.toISOString() };
}
