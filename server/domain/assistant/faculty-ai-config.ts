/**
 * The versioned AI setting of a faculty, `config/faculties/<faculty>.json`
 * (owner decisions OC-1 and OC-2 of 21. 11. 2026., Ductus#2052 c.7054441152;
 * Ductus docs/contracts/ai-tools-v1.md, "Prekidač ustanove" and "Odlazni
 * dohvat").
 *
 * The shape is closed: a format name, a version, the faculty slug, the two
 * flags of the institution switch and the list of search destinations. A
 * file that is not exactly this shape is no setting, and an institution
 * without a setting has both flags off and no destination. The file changes
 * only through a PR the owner approves; for the pilot every flag is false
 * and the destination list is empty, so search is never in the allowed set.
 *
 * Pure: the server layer reads the bytes and hands the parsed value in.
 */
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";
import {
  AI_SWITCH_OFF,
  allowedTools,
  CODE_TOOLS,
  readyTools,
  type InstitutionAiSwitch,
  type ToolName,
} from "./tools.ts";

export const FACULTY_AI_CONFIG_FORMAT = "ductura-faculty-ai-v1";
export const FACULTY_SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;
/** A destination id the server picks from the list; the model never names it. */
export const SEARCH_DESTINATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** At most this many destinations in one setting. */
export const SEARCH_DESTINATIONS_MAX = 16;

/** A search destination: a fixed `https` endpoint; the query only ever goes in `queryParameter`. */
export type SearchDestination = {
  readonly id: string;
  readonly endpoint: string;
  readonly queryParameter: string;
};

export type FacultyAiConfig = {
  readonly format: typeof FACULTY_AI_CONFIG_FORMAT;
  readonly version: number;
  readonly faculty: string;
  readonly aiSwitch: InstitutionAiSwitch;
  readonly searchDestinations: readonly SearchDestination[];
};

export type FacultyAiConfigRule =
  "not_object" | "unknown_key" | "format" | "version" | "faculty" | "switch" | "destinations";

export type FacultyAiConfigResult =
  | { readonly ok: true; readonly config: FacultyAiConfig }
  | { readonly ok: false; readonly rule: FacultyAiConfigRule };

const TOP_KEYS = new Set(["format", "version", "faculty", "aiSwitch", "searchDestinations"]);
const SWITCH_KEYS = new Set(["transcription", "tools"]);
const DESTINATION_KEYS = new Set(["id", "endpoint", "queryParameter"]);
const QUERY_PARAMETER = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * An endpoint the guard may call: `https`, a host name (no IP literal, no
 * user, no port other than the default), a path, no query and no fragment.
 */
export function isSearchEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.href === value &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "" &&
    /^[a-z0-9.-]+$/.test(url.hostname) &&
    !/^[0-9.]+$/.test(url.hostname) &&
    url.hostname.includes(".")
  );
}

function parseSwitch(value: unknown): InstitutionAiSwitch | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, SWITCH_KEYS)) return null;
  const { transcription, tools } = value;
  if (typeof transcription !== "boolean" || typeof tools !== "boolean") return null;
  return Object.freeze({ transcription, tools });
}

function parseDestinations(value: unknown): readonly SearchDestination[] | null {
  if (!Array.isArray(value) || value.length > SEARCH_DESTINATIONS_MAX) return null;
  const out: SearchDestination[] = [];
  for (const item of value as unknown[]) {
    if (!isPlainObject(item) || !hasOnlyKeys(item, DESTINATION_KEYS)) return null;
    const { id, endpoint, queryParameter } = item;
    if (
      typeof id !== "string" ||
      !SEARCH_DESTINATION_ID_PATTERN.test(id) ||
      out.some((d) => d.id === id) ||
      !isSearchEndpoint(endpoint) ||
      typeof queryParameter !== "string" ||
      !QUERY_PARAMETER.test(queryParameter)
    ) {
      return null;
    }
    out.push(Object.freeze({ id, endpoint, queryParameter }));
  }
  return Object.freeze(out);
}

/** The setting from a parsed JSON value, or the rule that failed. */
export function parseFacultyAiConfig(value: unknown): FacultyAiConfigResult {
  if (!isPlainObject(value)) return { ok: false, rule: "not_object" };
  if (!hasOnlyKeys(value, TOP_KEYS) || Object.keys(value).length !== TOP_KEYS.size)
    return { ok: false, rule: "unknown_key" };
  const { format, version, faculty, aiSwitch, searchDestinations } = value;
  if (format !== FACULTY_AI_CONFIG_FORMAT) return { ok: false, rule: "format" };
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    return { ok: false, rule: "version" };
  if (typeof faculty !== "string" || !FACULTY_SLUG_PATTERN.test(faculty))
    return { ok: false, rule: "faculty" };
  const parsedSwitch = parseSwitch(aiSwitch);
  if (parsedSwitch === null) return { ok: false, rule: "switch" };
  const destinations = parseDestinations(searchDestinations);
  if (destinations === null) return { ok: false, rule: "destinations" };
  return {
    ok: true,
    config: Object.freeze({
      format: FACULTY_AI_CONFIG_FORMAT,
      version,
      faculty,
      aiSwitch: parsedSwitch,
      searchDestinations: destinations,
    }),
  };
}

/** The switch of a setting; none at all is both flags off. */
export function aiSwitchOf(config: FacultyAiConfig | null): InstitutionAiSwitch {
  return config === null ? AI_SWITCH_OFF : config.aiSwitch;
}

/**
 * The tools the server side permits for one institution: the code set ∩ the
 * switch ∩ the ready tools. The database narrows it further with the
 * teacher's setting of the assignment and the policy (S3-D1).
 */
export function serverPermittedTools(config: FacultyAiConfig | null): readonly ToolName[] {
  return allowedTools({
    institutionSwitch: aiSwitchOf(config),
    assignmentTools: CODE_TOOLS,
    ready: readyTools(config?.searchDestinations ?? []),
  });
}
