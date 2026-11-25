import { enabledCheckIdsFor, lektaProfileOf, settingOf } from "../../domain/index.ts";

import type { WithActor } from "../index.ts";

// SRV-1101 (C-12): the text check configuration of the institution of an
// assignment in the caller's workspace. One withActor transaction: the
// assignment must be in app.student_workspace() (the access of the work
// itself), then the institution settings the caller may read
// (settings.read_institution_values, SRV-7E: a student sees only lekta.profile
// and citation.style). Nothing of any work is read.
const IN_WORKSPACE = "SELECT 1 FROM app.student_workspace() WHERE assignment_id = $1::uuid";
const SETTINGS = "SELECT key, value FROM settings.read_institution_values()";

export type TextCheckConfig = {
  enabledCheckIds: string[];
  lektaProfileId: string | null;
  citationStyle: string;
};

// citation.style of the institution: a stored value outside the catalogue, or no
// row, gives the catalogue default (fpzg). Unlike the Lekta profile, the default
// is shown: a student always formats in some style.
function citationStyleOf(stored: unknown): string {
  const definition = settingOf("citation.style");
  if (definition?.kind !== "enum") throw new Error("citation.style is not an enum setting");
  return typeof stored === "string" && definition.values.includes(stored)
    ? stored
    : definition.default;
}

/** The configuration, or null when the assignment is not in the caller's workspace. */
export async function readTextCheckConfig(
  withActor: WithActor,
  token: string,
  assignmentId: string,
): Promise<TextCheckConfig | null> {
  return withActor(token, async (tx) => {
    const found = await tx.query(IN_WORKSPACE, [assignmentId]);
    if (found.rows.length === 0) return null;
    const { rows } = await tx.query<{ key: string | null; value: unknown }>(SETTINGS);
    // No stored profile row: null. The catalogue default is not the institution's choice.
    const lektaProfileId = lektaProfileOf(rows.find((row) => row.key === "lekta.profile")?.value);
    const citationStyle = citationStyleOf(rows.find((row) => row.key === "citation.style")?.value);
    return { enabledCheckIds: enabledCheckIdsFor(lektaProfileId), lektaProfileId, citationStyle };
  });
}
