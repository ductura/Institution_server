// The faculty AI setting in the repository and its reader (OC-1, OC-2).
// Invented faculties only in the temporary files.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FACULTY_AI_CONFIG_FORMAT, parseFacultyAiConfig } from "../../domain/index.ts";

import {
  facultyAiSettingsOf,
  FACULTY_CONFIG_MAX_BYTES,
  readFacultyAiSettings,
} from "./faculty-config.ts";

const ROOT = fileURLToPath(new URL("../../../config/faculties/", import.meta.url));
const repoFiles = readdirSync(ROOT)
  .filter((name) => name.endsWith(".json"))
  .filter((name) => {
    const value = JSON.parse(readFileSync(join(ROOT, name), "utf8")) as unknown;
    return !(
      typeof value === "object" &&
      value !== null &&
      "format" in value &&
      value.format === "ductura-institution-config-v1"
    );
  });

/** Every boolean anywhere in a JSON value, with its path. */
function booleans(value: unknown, path = "$"): [string, boolean][] {
  if (typeof value === "boolean") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => booleans(item, `${path}[${i}]`));
  if (value !== null && typeof value === "object")
    return Object.entries(value).flatMap(([key, item]) => booleans(item, `${path}.${key}`));
  return [];
}

describe("config/faculties in the repository (OC-1, OC-2)", () => {
  it("has a setting for every institution of the institutions file", () => {
    // Read as text: this adapter imports only the domain (docs/server-map.md §2).
    const text = readFileSync(
      new URL("../../settings/institutions-file.ts", import.meta.url),
      "utf8",
    );
    const slugs = [...text.matchAll(/slug: "([a-z0-9-]+)"/gu)].map((match) => match[1]);
    expect(slugs.length).toBeGreaterThan(0);
    expect(repoFiles.map((name) => name.replace(/\.json$/u, "")).sort()).toEqual([...slugs].sort());
  });

  it.each(repoFiles)("%s: no flag is true; this test fails as soon as one is", (name) => {
    const value = JSON.parse(readFileSync(join(ROOT, name), "utf8")) as unknown;
    const on = booleans(value).filter(([, flag]) => flag !== false);
    expect(on, `flags switched on in ${name}`).toEqual([]);
  });

  it.each(repoFiles)(
    "%s: the closed shape, the version, both flags off, no destination",
    (name) => {
      const parsed = parseFacultyAiConfig(
        JSON.parse(readFileSync(join(ROOT, name), "utf8")) as unknown,
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.config.faculty).toBe(name.replace(/\.json$/u, ""));
      expect(parsed.config.version).toBeGreaterThanOrEqual(1);
      expect(parsed.config.aiSwitch).toEqual({ transcription: false, tools: false });
      expect(parsed.config.searchDestinations).toEqual([]);
    },
  );

  it("the reader over the repository: every institution off, no tool permitted, no destination", () => {
    const settings = readFacultyAiSettings(ROOT);
    expect(settings.faculties).toEqual(
      repoFiles.map((name) => name.replace(/\.json$/u, "")).sort(),
    );
    for (const slug of [...settings.faculties, "nepoznati-fakultet", null]) {
      expect(settings.readInstitutionAiSwitch(slug)).toEqual({
        transcription: false,
        tools: false,
      });
      expect(settings.permittedTools(slug)).toEqual([]);
      expect(settings.searchDestinations(slug)).toEqual([]);
    }
  });
});

describe("readFacultyAiSettings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function dirWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "faculty-ai-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }
  const on = (faculty: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      format: FACULTY_AI_CONFIG_FORMAT,
      version: 2,
      faculty,
      aiSwitch: { transcription: true, tools: true },
      searchDestinations: [
        { id: "trazilica-a", endpoint: "https://trazilica-a.invalid/search", queryParameter: "q" },
      ],
      ...extra,
    });

  it("a missing directory is every institution off (the production image)", () => {
    const settings = readFacultyAiSettings(join(tmpdir(), "nema-ove-mape-7c1e4b2a"));
    expect(settings.faculties).toEqual([]);
    expect(settings.readInstitutionAiSwitch("izmisljeni-fakultet")).toEqual({
      transcription: false,
      tools: false,
    });
  });

  it("a synthetic setting turns the tools on only for its own faculty", () => {
    const settings = readFacultyAiSettings(dirWith({ "izmisljeni-a.json": on("izmisljeni-a") }));
    expect(settings.permittedTools("izmisljeni-a")).toEqual(["web_search"]);
    expect(settings.searchDestinations("izmisljeni-a").map((d) => d.id)).toEqual(["trazilica-a"]);
    expect(settings.permittedTools("izmisljeni-b")).toEqual([]);
  });

  it("a file that names another faculty, breaks the shape, is too large or not JSON is off", () => {
    const settings = readFacultyAiSettings(
      dirWith({
        "izmisljeni-a.json": on("izmisljeni-b"),
        "izmisljeni-c.json": on("izmisljeni-c", { enabled: true }),
        "izmisljeni-d.json": on("izmisljeni-d").replace(
          "}",
          `, "x": "${"a".repeat(FACULTY_CONFIG_MAX_BYTES)}" }`,
        ),
        "izmisljeni-e.json": "{ nije json",
        "IZMISLJENI-F.json": on("izmisljeni-f"),
        "izmisljeni-g.txt": on("izmisljeni-g"),
      }),
    );
    expect(settings.faculties).toEqual([]);
    for (const slug of [
      "izmisljeni-a",
      "izmisljeni-b",
      "izmisljeni-c",
      "izmisljeni-d",
      "izmisljeni-f",
    ])
      expect(settings.permittedTools(slug)).toEqual([]);
  });

  it("the tools flag alone, without a destination, permits nothing (OC-2)", () => {
    const settings = facultyAiSettingsOf([
      {
        format: FACULTY_AI_CONFIG_FORMAT,
        version: 1,
        faculty: "izmisljeni-a",
        aiSwitch: { transcription: false, tools: true },
        searchDestinations: [],
      },
    ]);
    expect(settings.permittedTools("izmisljeni-a")).toEqual([]);
    expect(settings.readInstitutionAiSwitch("izmisljeni-a")).toEqual({
      transcription: false,
      tools: true,
    });
  });
});
