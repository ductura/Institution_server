/**
 * The server-layer reader of the faculty AI setting,
 * `config/faculties/<faculty>.json` (owner decisions OC-1 and OC-2 of
 * 21. 11. 2026.; Ductus docs/contracts/ai-tools-v1.md, "Prekidač ustanove").
 *
 * It replaces the constant of SRV-1206 with the same default: an institution
 * without a valid setting file has both flags off and no search destination.
 * Files are read once, when the composition is built; nothing on any path for
 * a student, a teacher or an administrator changes them (S3-D6). A file
 * changes only through a PR the owner approves, and for the pilot every flag
 * is false and every destination list empty.
 *
 * The production image carries only the bundle, so there the directory is
 * missing and every institution is off: the safe default, never a widening.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  aiSwitchOf,
  FACULTY_SLUG_PATTERN,
  parseFacultyAiConfig,
  serverPermittedTools,
  type FacultyAiConfig,
  type InstitutionAiSwitch,
  type SearchDestination,
  type ToolName,
} from "../../domain/index.ts";

/** A setting file is small; a larger one is no setting. */
export const FACULTY_CONFIG_MAX_BYTES = 16 * 1024;
const FILE_NAME = /^([a-z0-9-]{2,32})\.json$/;

export type FacultyAiSettings = {
  /** The faculties with a valid setting, by slug. */
  readonly faculties: readonly string[];
  /** The switch of an institution by its slug; both flags off without a setting. */
  readInstitutionAiSwitch(institutionSlug: string | null): InstitutionAiSwitch;
  /** CODE_TOOLS ∩ switch.tools ∩ ready, for begin_request and begin_tool_step. */
  permittedTools(institutionSlug: string | null): readonly ToolName[];
  /** The search destinations of an institution; empty in the pilot (OC-2). */
  searchDestinations(institutionSlug: string | null): readonly SearchDestination[];
};

/** Settings over parsed configurations; for tests and for `readFacultyAiSettings`. */
export function facultyAiSettingsOf(configs: readonly FacultyAiConfig[]): FacultyAiSettings {
  const bySlug = new Map<string, FacultyAiConfig>();
  for (const config of configs) bySlug.set(config.faculty, config);
  const find = (slug: string | null) =>
    slug !== null && FACULTY_SLUG_PATTERN.test(slug) ? (bySlug.get(slug) ?? null) : null;
  return Object.freeze({
    faculties: Object.freeze([...bySlug.keys()].sort()),
    readInstitutionAiSwitch: (slug: string | null) => aiSwitchOf(find(slug)),
    permittedTools: (slug: string | null) => serverPermittedTools(find(slug)),
    searchDestinations: (slug: string | null) => find(slug)?.searchDestinations ?? [],
  });
}

/** One setting file, or null when it is not exactly a setting of that faculty. */
export function readFacultyAiConfigFile(path: string, slug: string): FacultyAiConfig | null {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > FACULTY_CONFIG_MAX_BYTES) return null;
    const parsed = parseFacultyAiConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
    return parsed.ok && parsed.config.faculty === slug ? parsed.config : null;
  } catch {
    return null;
  }
}

/**
 * Every `<slug>.json` directly in `root`. A missing directory, a file that
 * does not parse or names another faculty: no setting, so off.
 */
export function readFacultyAiSettings(root: string): FacultyAiSettings {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    names = [];
  }
  const configs: FacultyAiConfig[] = [];
  for (const name of names.sort()) {
    const slug = FILE_NAME.exec(name)?.[1];
    if (slug === undefined) continue;
    const config = readFacultyAiConfigFile(join(root, name), slug);
    if (config !== null) configs.push(config);
  }
  return facultyAiSettingsOf(configs);
}
