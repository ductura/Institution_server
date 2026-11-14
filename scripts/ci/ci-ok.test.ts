import { describe, expect, it } from "vitest";
import { CI_OK_MESSAGES, evaluateCiOk } from "./index.ts";

const needs = (results: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { result: v }])));
const ALL = { scope: "success", checks: "success", database: "success" };

describe("evaluateCiOk", () => {
  it("passes when every required job succeeded", () => {
    expect(evaluateCiOk("full", needs(ALL))).toEqual({ ok: true });
  });

  it("passes a docs-only change with the database job skipped", () => {
    expect(evaluateCiOk("docs", needs({ ...ALL, database: "skipped" }))).toEqual({ ok: true });
  });

  it("passes a docs-only change whose database job ran anyway", () => {
    expect(evaluateCiOk("docs", needs(ALL))).toEqual({ ok: true });
  });

  it.each(["scope", "checks", "database"])("a failed %s fails ci-ok", (job) => {
    for (const result of ["failure", "cancelled", "skipped", "neutral", "", "SUCCESS"]) {
      const verdict = evaluateCiOk("full", needs({ ...ALL, [job]: result }));
      expect(verdict).toMatchObject({ ok: false, error: { code: "jobNotSuccessful", job } });
    }
  });

  it("a failed database job fails ci-ok also for docs", () => {
    for (const result of ["failure", "cancelled"]) {
      const verdict = evaluateCiOk("docs", needs({ ...ALL, database: result }));
      expect(verdict).toMatchObject({ ok: false, error: { job: "database" } });
    }
  });

  it("checks skipped for docs still fails", () => {
    const verdict = evaluateCiOk("docs", needs({ ...ALL, checks: "skipped" }));
    expect(verdict).toMatchObject({ ok: false, error: { job: "checks" } });
  });

  it.each(["scope", "checks", "database"])("a missing %s fails ci-ok", (job) => {
    const results: Record<string, string> = { ...ALL };
    delete results[job];
    expect(evaluateCiOk("full", needs(results))).toMatchObject({
      ok: false,
      error: { code: "jobMissing", job },
    });
  });

  it.each(["deploy", "toString", "constructor", "hasOwnProperty"])(
    "an unexpected job %s fails ci-ok",
    (job) => {
      expect(evaluateCiOk("full", needs({ ...ALL, [job]: "success" }))).toMatchObject({
        ok: false,
        error: { code: "jobUnexpected", job },
      });
    },
  );

  it("an own __proto__ key is unexpected, not ignored", () => {
    const raw = needs(ALL).replace(/^\{/, '{"__proto__":{"result":"success"},');
    expect(evaluateCiOk("full", raw)).toMatchObject({
      ok: false,
      error: { code: "jobUnexpected", job: "__proto__" },
    });
  });

  it("inherited keys do not stand in for a missing job", () => {
    const raw = needs({ scope: "success", checks: "success" });
    expect(evaluateCiOk("full", raw)).toMatchObject({ ok: false, error: { job: "database" } });
  });

  it.each([
    ["not JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["string", '"success"'],
    ["job is not an object", JSON.stringify({ ...ALL, checks: "success" })],
    ["result is not a string", JSON.stringify({ scope: { result: 1 } })],
  ])("malformed needs (%s) fails ci-ok", (label, raw) => {
    expect(evaluateCiOk("full", raw).ok).toBe(false);
  });

  it.each(["", "Docs", "tests", "full\n", "toString", undefined])(
    "unknown profile %j fails ci-ok",
    (profile) => {
      expect(evaluateCiOk(profile, needs(ALL))).toMatchObject({
        ok: false,
        error: { code: "profileInvalid" },
      });
    },
  );

  it("every error code has a message", () => {
    const codes = ["profileInvalid", "needsInvalid", "jobMissing", "jobUnexpected"];
    for (const code of [...codes, "jobNotSuccessful"]) {
      expect(CI_OK_MESSAGES[code as keyof typeof CI_OK_MESSAGES]).toMatch(/\S/);
    }
  });
});
