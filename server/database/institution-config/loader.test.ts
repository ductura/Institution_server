// SRV-1405: the closed schema of the faculty rules and the loader that checks
// every config/faculties/<faculty>/rules.json at start. Acceptance (2): an
// invalid faculty file refuses the start with a clear code; (4) the invented
// faculties of the repository load. Every faculty below is invented.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FACULTY_RULES_ERROR_CODES,
  FACULTY_RULES_FORMAT,
  facultyRulesProblems,
  facultyRulesSchema,
  loadFacultyRules,
} from "./index.ts";

const REPOSITORY = new URL("../../../config/faculties/", import.meta.url).pathname;
const RULES = { citationStyle: "fpzg", workLanguages: ["hr", "en"], defaultWorkLanguage: "hr" };
const file = (faculty: string, rules: unknown = RULES) => ({
  format: FACULTY_RULES_FORMAT,
  faculty,
  rules,
});

const roots: string[] = [];
function root(files: Record<string, string | unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "faculty-rules-"));
  roots.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("facultyRulesSchema", () => {
  it("accepts the decided settings", () => {
    expect(facultyRulesSchema.safeParse(RULES).success).toBe(true);
    expect(
      facultyRulesSchema.safeParse({ ...RULES, workLanguages: ["en"], defaultWorkLanguage: "en" })
        .success,
    ).toBe(true);
  });

  it.each([
    ["an unknown key", { ...RULES, aiPolicy: "encouraged" }],
    ["an undecided retention", { ...RULES, retentionDays: 30 }],
    ["an unknown citation style", { ...RULES, citationStyle: "apa" }],
    ["an unknown language", { ...RULES, workLanguages: ["hr", "de"] }],
    ["no language", { ...RULES, workLanguages: [] }],
    ["a repeated language", { ...RULES, workLanguages: ["hr", "hr"] }],
    [
      "a default that is not offered",
      { ...RULES, workLanguages: ["en"], defaultWorkLanguage: "hr" },
    ],
    ["a missing key", { citationStyle: "fpzg", workLanguages: ["hr"] }],
    ["not an object", ["hr"]],
  ])("refuses %s", (_name, input) => {
    expect(facultyRulesSchema.safeParse(input).success).toBe(false);
  });
});

describe("the faculties of the repository (acceptance 4)", () => {
  it("load, with rules for the invented faculties only", () => {
    const loaded = loadFacultyRules(REPOSITORY);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.faculties).toEqual(["demo-fakultet", "demo-fakultet-b"]);
    expect(loaded.value.rulesOf("demo-fakultet")).toEqual(RULES);
    expect(loaded.value.rulesOf("fpzg")).toBeNull();
    expect(loaded.value.rulesOf(null)).toBeNull();
    expect(facultyRulesProblems(REPOSITORY)).toEqual([]);
  });

  it("leave the AI setting files of OC-1 as they were", () => {
    const ai = JSON.parse(readFileSync(join(REPOSITORY, "demo-fakultet.json"), "utf8")) as unknown;
    expect(ai).toEqual({
      format: "ductura-faculty-ai-v1",
      version: 1,
      faculty: "demo-fakultet",
      aiSwitch: { transcription: false, tools: false },
      searchDestinations: [],
    });
  });
});

describe("loadFacultyRules", () => {
  it("reads no rules from a missing directory, as in the production image", () => {
    const loaded = loadFacultyRules(join(tmpdir(), "nema-ove-mape-faculty-rules"));
    expect(loaded.ok && loaded.value.faculties).toEqual([]);
  });

  it("skips a faculty directory without a rules file and the AI setting files", () => {
    const dir = root({
      "izmisljeni-a/declaration/1.json": "{}",
      "izmisljeni-a.json": "{",
      "izmisljeni-b/rules.json": file("izmisljeni-b"),
    });
    const loaded = loadFacultyRules(dir);
    expect(loaded.ok && loaded.value.faculties).toEqual(["izmisljeni-b"]);
  });

  it.each([
    ["FACULTY_RULES_NOT_JSON", "{ nije json", ""],
    ["FACULTY_RULES_SCHEMA", { ...file("izmisljeni"), format: "drugi-v9" }, "format"],
    [
      "FACULTY_RULES_SCHEMA",
      file("izmisljeni", { ...RULES, workLanguages: ["hr", "xx"] }),
      "rules.workLanguages.1",
    ],
    [
      "FACULTY_RULES_SCHEMA",
      file("izmisljeni", { ...RULES, defaultWorkLanguage: "en", workLanguages: ["hr"] }),
      "rules.defaultWorkLanguage",
    ],
    ["FACULTY_RULES_SCHEMA", { ...file("izmisljeni"), extra: true }, ""],
    ["FACULTY_RULES_FACULTY_MISMATCH", file("drugi-fakultet"), "faculty"],
    ["FACULTY_RULES_TOO_LARGE", { ...file("izmisljeni"), pad: "x".repeat(17_000) }, ""],
  ])("refuses the start with %s (acceptance 2)", (code, content, field) => {
    const dir = root({
      "izmisljeni/rules.json": content,
      "ok-fakultet/rules.json": file("ok-fakultet"),
    });
    const loaded = loadFacultyRules(dir);
    expect(loaded).toEqual({
      ok: false,
      error: {
        code,
        messageKey: `facultyRules.${code.toLowerCase()}`,
        file: "izmisljeni/rules.json",
        field,
      },
    });
    expect(facultyRulesProblems(dir)).toEqual([
      `faculty rules are refused: ${code} izmisljeni/rules.json${field === "" ? "" : ` ${field}`}`,
    ]);
  });

  it("refuses a rules file that is a link", () => {
    const dir = root({ "drugdje.json": file("izmisljeni") });
    mkdirSync(join(dir, "izmisljeni"));
    symlinkSync(join(dir, "drugdje.json"), join(dir, "izmisljeni", "rules.json"));
    const loaded = loadFacultyRules(dir);
    expect(!loaded.ok && loaded.error.code).toBe("FACULTY_RULES_UNREADABLE");
  });

  it("never repeats a value of the file in the problem line", () => {
    const secret = "tajna-vrijednost-iz-datoteke";
    const dir = root({
      "izmisljeni/rules.json": file("izmisljeni", { ...RULES, citationStyle: secret }),
    });
    expect(facultyRulesProblems(dir).join("")).not.toContain(secret);
  });

  it("has a Croatian text for every error code", () => {
    const hr = JSON.parse(
      readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
    ) as {
      facultyRules: Record<string, string>;
    };
    expect(Object.keys(hr.facultyRules).sort()).toEqual(
      FACULTY_RULES_ERROR_CODES.map((code) => code.toLowerCase()).sort(),
    );
  });
});
