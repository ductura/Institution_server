// The body of POST /api/v1/institution/assignments/{assignmentId}/versions.
// Literal port of parseAssignmentInput, validInstant and isWordCount of Ductus
// src/server/institution/create-assignment.ts and of parseBody and isVersion
// of src/server/institution/assignment-version-route.ts at 078c780, with the
// order and form of every check kept. Changes are of naming, export and
// types only: wordRangeRequired is always true here (a new version names
// both bounds, null drops one), so parseAssignmentInput takes no flag; the
// result narrows nothing the checks do not already require. The RPC
// (institution.publish_assignment_version) judges tightening and versions.

const MAX_WORDS = 1_000_000;
const MAX_VERSION = 2_147_483_647;
const NUL = "\u0000";
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const WORK_TYPES = new Set([
  "short_paper",
  "essay",
  "seminar_paper",
  "bachelor_thesis",
  "master_thesis",
  "specialist_thesis",
  "doctoral_thesis",
]);
const AI_POLICIES = new Set(["prohibited", "partially_allowed", "encouraged"]);
const AI_PURPOSES = new Set([
  "formatting",
  "proofreading",
  "literature_search",
  "transcription",
  "translation",
]);

export type AssignmentContent = {
  title: string;
  instructions: string;
  workType: string;
  opensAt: string;
  dueAt: string;
  aiPolicy: string;
  aiPurposes: string[];
  evidenceProfile: string;
  importAllowed: boolean;
  wordMin: number | null;
  wordMax: number | null;
};

export type AssignmentVersionBody = { expectedVersion: number; content: AssignmentContent };

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A calendar instant whose UTC year is 1000 to 9999, as
 * institution.is_assignment_content holds it (DAN-306): below year 1000 UTC
 * PostgreSQL and JS can write different years for the same instant.
 */
function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_INSTANT.exec(value);
  if (!match || Number(match[1]) < 1) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const utcYear = new Date(instant).getUTCFullYear();
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day &&
    utcYear >= 1000 &&
    utcYear <= 9999
  );
}

/** Null or a whole number of words from 1 to 1 000 000, as institution.is_word_range. */
function isWordCount(value: unknown): value is number | null {
  return (
    value === null ||
    (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_WORDS)
  );
}

/** The closed content of a new assignment version, both word bounds named. */
export function parseAssignmentInput(value: unknown): AssignmentContent | null {
  if (!isObject(value)) return null;
  const keys = [
    "title",
    "instructions",
    "workType",
    "opensAt",
    "dueAt",
    "aiPolicy",
    "aiPurposes",
    "evidenceProfile",
    "importAllowed",
  ];
  const range = ["wordMin", "wordMax"].filter((key) => Object.hasOwn(value, key)).length;
  if (range !== 2) return null;
  if (Object.keys(value).length !== keys.length + range || keys.some((key) => !(key in value))) {
    return null;
  }
  const wordMin = value.wordMin ?? null;
  const wordMax = value.wordMax ?? null;
  if (
    !isWordCount(wordMin) ||
    !isWordCount(wordMax) ||
    (wordMin !== null && wordMax !== null && wordMin > wordMax)
  ) {
    return null;
  }
  if (
    typeof value.title !== "string" ||
    typeof value.instructions !== "string" ||
    typeof value.workType !== "string" ||
    !validInstant(value.opensAt) ||
    !validInstant(value.dueAt) ||
    typeof value.aiPolicy !== "string" ||
    !Array.isArray(value.aiPurposes) ||
    !value.aiPurposes.every((purpose) => typeof purpose === "string") ||
    typeof value.evidenceProfile !== "string" ||
    typeof value.importAllowed !== "boolean"
  ) {
    return null;
  }
  const aiPurposes = value.aiPurposes as string[];
  if (
    Array.from(value.title).length === 0 ||
    Array.from(value.title).length > 200 ||
    value.title.includes(NUL) ||
    Array.from(value.instructions).length > 20_000 ||
    value.instructions.includes(NUL) ||
    !WORK_TYPES.has(value.workType) ||
    !AI_POLICIES.has(value.aiPolicy) ||
    !["basic", "extended"].includes(value.evidenceProfile) ||
    aiPurposes.length > 5 ||
    new Set(aiPurposes).size !== aiPurposes.length ||
    aiPurposes.some((purpose) => !AI_PURPOSES.has(purpose)) ||
    (value.aiPolicy === "prohibited" && aiPurposes.length !== 0)
  ) {
    return null;
  }
  return {
    title: value.title,
    instructions: value.instructions,
    workType: value.workType,
    opensAt: value.opensAt,
    dueAt: value.dueAt,
    aiPolicy: value.aiPolicy,
    aiPurposes,
    evidenceProfile: value.evidenceProfile,
    importAllowed: value.importAllowed,
    wordMin,
    wordMax,
  };
}

export const isAssignmentVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_VERSION;

/** `expectedVersion` and exactly the content of a version (Ductus parseBody). */
export function parseAssignmentVersionBody(value: unknown): AssignmentVersionBody | null {
  if (!isObject(value) || !Object.hasOwn(value, "expectedVersion")) return null;
  const { expectedVersion, ...fields } = value;
  if (!isAssignmentVersion(expectedVersion)) return null;
  const content = parseAssignmentInput(fields);
  return content && { expectedVersion, content };
}
