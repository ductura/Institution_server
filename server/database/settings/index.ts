import { SETTINGS_CATALOGUE } from "../../domain/index.ts";

import type { WithActor } from "../index.ts";

export { readTextCheckConfig, type TextCheckConfig } from "./text-check-config.ts";

export const settingsCatalogue = { keys: SETTINGS_CATALOGUE };

type SettingRow = {
  key: string | null;
  value: unknown;
  bound: unknown;
  updated_at: Date | null;
  editorOnly?: boolean;
};
const READ_SQL = "SELECT key, value, bound, updated_at FROM settings.read_values($1, $2::uuid)";
const READ_INSTITUTION_SQL = `SELECT editor_only AS "editorOnly", key, value, bound, updated_at
  FROM settings.read_institution_values() ORDER BY key`;
const EDITOR_KEYS = new Set(["citation.style", "lekta.profile"]);
const REFUSALS = new Map<unknown, 401 | 404 | 422>([
  ["ZD401", 401],
  ["ZD403", 404],
  ["ZD422", 422],
] as const);

export async function readSettingsValues(
  withActor: WithActor,
  token: string,
  level: string,
  course: string | null,
) {
  const institution = level === "institution" && course === null;
  let rows: SettingRow[];
  try {
    rows = await withActor(
      token,
      async (tx) =>
        (institution
          ? await tx.query<SettingRow>(READ_INSTITUTION_SQL)
          : await tx.query<SettingRow>(READ_SQL, [level, course])
        ).rows,
    );
  } catch (error) {
    const status = REFUSALS.get((error as { code?: unknown } | null)?.code);
    if (status === undefined) throw error;
    return { status };
  }

  const editorOnly = rows[0]?.editorOnly;
  if (institution && typeof editorOnly !== "boolean")
    throw new Error("missing institution settings scope");

  const definitions = SETTINGS_CATALOGUE.filter(
    (entry) =>
      entry.levels.some((item) => item === level) && (!editorOnly || EDITOR_KEYS.has(entry.key)),
  );
  // Every current key has one level. A shared key will need a scoped read
  // of higher values and bounds before its inherited value can be returned.
  if (definitions.some((entry) => entry.levels.length > 1)) {
    throw new Error("settings inheritance requires a read of higher levels");
  }
  const inherited = definitions.map(({ key, default: value }) => ({
    key,
    value,
    source: "default",
    bound: null,
  }));
  const values = rows.flatMap(({ key, value, bound, updated_at: updatedAt }) => {
    // A successful institutional read with no stored values has only a scope row.
    if (institution && key === null && updatedAt === null) return [];
    if (key === null || updatedAt === null || (editorOnly && !EDITOR_KEYS.has(key))) {
      throw new Error("invalid settings row for the authorized scope");
    }
    return [{ key, value, bound, updatedAt: updatedAt.toISOString() }];
  });
  return { status: 200 as const, body: { level, course, values, inherited } };
}
