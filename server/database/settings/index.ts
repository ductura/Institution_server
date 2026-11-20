import { SETTINGS_CATALOGUE } from "../../domain/index.ts";

import type { WithActor } from "../index.ts";

export const settingsCatalogue = { keys: SETTINGS_CATALOGUE };

type SettingRow = { key: string; value: unknown; bound: unknown; updated_at: Date };
const READ_SQL = "SELECT key, value, bound, updated_at FROM settings.read_values($1, $2::uuid)";
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
  let rows: SettingRow[];
  try {
    rows = await withActor(
      token,
      async (tx) => (await tx.query<SettingRow>(READ_SQL, [level, course])).rows,
    );
  } catch (error) {
    const status = REFUSALS.get((error as { code?: unknown } | null)?.code);
    if (status === undefined) throw error;
    return { status };
  }

  const definitions = SETTINGS_CATALOGUE.filter((entry) =>
    entry.levels.some((item) => item === level),
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
  const values = rows.map(({ key, value, bound, updated_at: updatedAt }) => ({
    key,
    value,
    bound,
    updatedAt: updatedAt.toISOString(),
  }));
  return { status: 200 as const, body: { level, course, values, inherited } };
}
