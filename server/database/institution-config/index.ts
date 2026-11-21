import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import {
  FACULTY_AI_CONFIG_FORMAT,
  FACULTY_SLUG_PATTERN,
  parseFacultyAiConfig,
} from "../../domain/index.ts";

const facultyConfigSchema = z.strictObject({
  format: z.literal("ductura-institution-config-v1"),
  faculty: z.string().regex(FACULTY_SLUG_PATTERN),
  version: z.int().min(1).max(2_147_483_647),
  rules: z.strictObject({
    evidenceProfile: z.enum(["basic", "extended"]),
    importAllowed: z.boolean(),
  }),
});

export type FacultyConfig = z.infer<typeof facultyConfigSchema>;
const MAX_BYTES = 16 * 1024;
const FACULTY_FILE = /^([a-z0-9-]{2,32})(\.rules)?\.json$/;

type FacultyConfigs = { configs: FacultyConfig[]; problems: string[] };

export function loadFacultyConfigs(root: string): FacultyConfigs {
  const directory = join(root, "config", "faculties");
  const configs: FacultyConfig[] = [];
  const problems: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // A standalone server bundle can run with the published database versions.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      problems.push("FACULTY_CONFIG_READ_FAILED");
    }
    return { configs, problems };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!/\.json$/i.test(entry.name)) continue;
    const name = FACULTY_FILE.exec(entry.name);
    const faculty = name?.[1];
    if (faculty === undefined || !entry.isFile()) {
      problems.push("FACULTY_CONFIG_INVALID_FILE");
      continue;
    }
    let input: unknown;
    try {
      const path = join(directory, entry.name);
      if (statSync(path).size > MAX_BYTES) {
        problems.push(`FACULTY_CONFIG_TOO_LARGE: ${faculty}`);
        continue;
      }
      input = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      const code =
        error instanceof SyntaxError ? "FACULTY_CONFIG_INVALID_JSON" : "FACULTY_CONFIG_READ_FAILED";
      problems.push(`${code}: ${faculty}`);
      continue;
    }
    if (
      typeof input === "object" &&
      input !== null &&
      "format" in input &&
      input.format === FACULTY_AI_CONFIG_FORMAT &&
      name?.[2] === undefined
    ) {
      const ai = parseFacultyAiConfig(input);
      if (ai.ok && ai.config.faculty === faculty) continue;
    } else {
      const parsed = facultyConfigSchema.safeParse(input, { jitless: true });
      if (parsed.success && parsed.data.faculty === faculty) {
        if (configs.some((config) => config.faculty === faculty)) {
          problems.push(`FACULTY_CONFIG_DUPLICATE: ${faculty}`);
        } else {
          configs.push(parsed.data);
        }
        continue;
      }
    }
    problems.push(`FACULTY_CONFIG_INVALID_SCHEMA: ${faculty}`);
  }
  return { configs, problems };
}

export function facultyConfigProblems(root: string): string[] {
  return loadFacultyConfigs(root).problems;
}
