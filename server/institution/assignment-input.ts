// The content of an assignment version (SRV-14, Ductus#2028 c.7008147932):
// literal port of parseAssignmentInput, validInstant and isWordCount of Ductus
// src/server/institution/create-assignment.ts at 078c780 (the copy in
// create-assignment.ts still imports Next), with the order and form of every
// check kept. Changes: AssignmentInput is a type, NUL is a regular expression
// (no-hardcoded-text), and parseAssignmentVersionBody
// is the body check of assignment-version-route.ts (parseBody). The RPCs
// (institution.create_assignment, publish_assignment_version) judge further.
const MAX_WORDS = 1_000_000;
/** The one character the RPCs refuse in a title or instructions (Ductus NUL). */
const NUL = /\u0000/;
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

export type AssignmentInput = {
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

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A calendar instant whose UTC year is 1000 to 9999, as
 * institution.is_assignment_content holds it (DAN-306). The range is checked
 * after the offset is applied: below year 1000 UTC, PostgreSQL's to_char and
 * Date.prototype.toISOString can write different years for the same instant
 * (1 BC is 0001 and 0000), and the notice fingerprint would not be the same
 * bytes in both languages.
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

/**
 * The closed content of an assignment version. `wordRangeRequired` is for a
 * new version (DAN-292): there `null` drops a bound, so an absent key must
 * not drop it silently.
 */
export function parseAssignmentInput(
  value: unknown,
  wordRangeRequired = false,
): AssignmentInput | null {
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
  // The word range (DAN-229) is optional: an absent key is null, so an older client still creates.
  const range = ["wordMin", "wordMax"].filter((key) => Object.hasOwn(value, key)).length;
  if (wordRangeRequired && range !== 2) return null;
  if (Object.keys(value).length !== keys.length + range || keys.some((key) => !(key in value)))
    return null;
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
    NUL.test(value.title) ||
    Array.from(value.instructions).length > 20_000 ||
    NUL.test(value.instructions) ||
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

const MAX_VERSION = 2_147_483_647;

/** A version number of an assignment, 1 to 2^31 - 1. */
export const isAssignmentVersion = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_VERSION;

/** `expectedVersion` and exactly the content of a version, with both word bounds named. */
export function parseAssignmentVersionBody(
  value: unknown,
): { expectedVersion: number; content: AssignmentInput } | null {
  if (!isObject(value) || !Object.hasOwn(value, "expectedVersion")) return null;
  const { expectedVersion, ...fields } = value;
  if (!isAssignmentVersion(expectedVersion)) return null;
  const content = parseAssignmentInput(fields, true);
  return content && { expectedVersion, content };
}
