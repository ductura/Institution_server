import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadFacultyConfigs } from "./index.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const config = {
  format: "ductura-institution-config-v1",
  faculty: "fak-a",
  version: 1,
  rules: { evidenceProfile: "basic", importAllowed: false },
};

describe("institution configuration on disk", () => {
  let fixture: string;
  let directory: string;

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), "csrv1405-"));
    directory = join(fixture, "config", "faculties");
    mkdirSync(directory, { recursive: true });
  });

  afterEach(() => rmSync(fixture, { recursive: true, force: true }));

  it("loads the fictional example and validates the existing AI files", () => {
    const result = loadFacultyConfigs(root);
    expect(result.problems).toEqual([]);
    expect(result.configs).toContainEqual({ ...config, faculty: "demo-pravila" });
  });

  it("permits the standalone bundle to run with database versions", () => {
    rmdirSync(directory);
    expect(loadFacultyConfigs(fixture)).toEqual({ configs: [], problems: [] });
  });

  it("rejects a rules file with another faculty, unknown fields, or a bad version", () => {
    for (const bad of [
      { ...config, faculty: "fak-b" },
      { ...config, rules: { ...config.rules, unknown: true } },
      { ...config, rules: { ...config.rules, importAllowed: "false" } },
      { ...config, version: 2_147_483_648 },
    ]) {
      writeFileSync(join(directory, "fak-a.json"), JSON.stringify(bad));
      expect(loadFacultyConfigs(fixture)).toEqual({
        configs: [],
        problems: ["FACULTY_CONFIG_INVALID_SCHEMA: fak-a"],
      });
    }
  });

  it("rejects invalid JSON without logging its contents", () => {
    writeFileSync(join(directory, "fak-a.json"), "{ malformed");
    expect(loadFacultyConfigs(fixture).problems).toEqual(["FACULTY_CONFIG_INVALID_JSON: fak-a"]);
  });

  it("loads institution rules alongside an existing AI setting and rejects two rules files", () => {
    const primary = join(directory, "fak-a.json");
    writeFileSync(
      primary,
      JSON.stringify({
        format: "ductura-faculty-ai-v1",
        faculty: "fak-a",
        version: 1,
        aiSwitch: { transcription: false, tools: false },
        searchDestinations: [],
      }),
    );
    writeFileSync(join(directory, "fak-a.rules.json"), JSON.stringify(config));
    expect(loadFacultyConfigs(fixture)).toEqual({ configs: [config], problems: [] });

    writeFileSync(primary, JSON.stringify(config));
    expect(loadFacultyConfigs(fixture).problems).toEqual(["FACULTY_CONFIG_DUPLICATE: fak-a"]);
  });
});
