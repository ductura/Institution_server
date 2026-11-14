import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobsFor, type Profile } from "./scope.ts";

/** Text for every error code, printed in the CI log. */
export const CI_OK_MESSAGES = Object.freeze({
  profileInvalid: "Profil CI-ja nije „docs” ni „full”.",
  needsInvalid: "Rezultati poslova nisu ispravan JSON objekt poslova.",
  jobMissing: "Potrebni posao nema rezultat.",
  jobUnexpected: "Nepoznat posao u rezultatima; ci-ok ga mora izričito poznavati.",
  jobNotSuccessful: "Potrebni posao nije uspio.",
});

export type CiOkCode = keyof typeof CI_OK_MESSAGES;
export type CiOkError = { code: CiOkCode; job?: string; result?: string };
export type CiOkVerdict = { ok: true } | { ok: false; error: CiOkError };

const PROFILES: ReadonlySet<string> = new Set<Profile>(["docs", "full"]);
const ALL_JOBS = ["scope", ...jobsFor("full")];

function fail(code: CiOkCode, job?: string, result?: string): CiOkVerdict {
  const error: CiOkError = { code };
  if (job !== undefined) error.job = job;
  if (result !== undefined) error.result = result;
  return { ok: false, error };
}

function parseResults(needsJson: string): Map<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(needsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const results = new Map<string, string>();
  for (const [job, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) return null;
    const result: unknown = Object.hasOwn(value, "result") ? Reflect.get(value, "result") : null;
    if (typeof result !== "string") return null;
    results.set(job, result);
  }
  return results;
}

/**
 * The verdict of the aggregate `ci-ok` job from `toJSON(needs)`. Every job must
 * be known and successful; only `database` may be skipped, and only for docs.
 */
export function evaluateCiOk(profile: unknown, needsJson: string): CiOkVerdict {
  if (typeof profile !== "string" || !PROFILES.has(profile)) return fail("profileInvalid");
  const results = parseResults(needsJson);
  if (!results) return fail("needsInvalid");
  for (const job of results.keys()) {
    if (!ALL_JOBS.includes(job)) return fail("jobUnexpected", job);
  }
  const required = new Set(["scope", ...jobsFor(profile as Profile)]);
  for (const job of ALL_JOBS) {
    const result = results.get(job);
    if (result === undefined) return fail("jobMissing", job);
    const allowed = required.has(job)
      ? result === "success"
      : ["success", "skipped"].includes(result);
    if (!allowed) return fail("jobNotSuccessful", job, result);
  }
  return { ok: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = evaluateCiOk(process.env["PROFILE"], readFileSync(0, "utf8"));
  if (!verdict.ok) {
    const { code, job, result } = verdict.error;
    process.stderr.write(`ci-ok: ${CI_OK_MESSAGES[code]} (${code} ${job ?? ""} ${result ?? ""})\n`);
    process.exit(1);
  }
  process.stdout.write("ci-ok: svi potrebni poslovi uspjeli\n");
}
