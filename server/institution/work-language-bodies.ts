// The bodies of the three work language routes (contracts
// institution.work-language.post, institution.student-work-language.post,
// institution.work-work-language.post). Literal port of closedBody,
// exceptionLanguage and the body check of handleAssignmentWorkLanguageRequest
// in Ductus src/server/institution/work-language-route.ts at 078c780, with
// the order of every check kept; the only changes are of form: each check is
// a function that returns the body or null (the route's 422) instead of a
// response. The RPC judges who may and when.
import { parseWorkLanguage, type WorkLanguage } from "../domain/index.ts";

const MAX_VERSION = 2_147_483_647;

export type AssignmentWorkLanguageBody = { expectedVersion: number; language: WorkLanguage };
/** One work's exception; null removes it. */
export type WorkLanguageExceptionBody = { language: WorkLanguage | null };

/** A plain object whose own keys are exactly `keys`, in any order; anything else is null. */
function closedBody(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
  return value as Record<string, unknown>;
}

/** Exactly {expectedVersion, language}: a version from 1 to 2 147 483 647 and a known language. */
export function parseAssignmentWorkLanguageBody(value: unknown): AssignmentWorkLanguageBody | null {
  const body = closedBody(value, ["expectedVersion", "language"]);
  const expectedVersion = body?.expectedVersion;
  const language = parseWorkLanguage(body?.language);
  if (
    !Number.isSafeInteger(expectedVersion) ||
    (expectedVersion as number) < 1 ||
    (expectedVersion as number) > MAX_VERSION ||
    language === null
  ) {
    return null;
  }
  return { expectedVersion: expectedVersion as number, language };
}

/** Exactly {language} with a known language or null; anything else is null (Ductus undefined). */
export function parseWorkLanguageExceptionBody(value: unknown): WorkLanguageExceptionBody | null {
  const body = closedBody(value, ["language"]);
  if (!body) return null;
  if (body.language === null) return { language: null };
  const language = parseWorkLanguage(body.language);
  return language === null ? null : { language };
}
