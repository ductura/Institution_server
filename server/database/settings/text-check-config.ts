import { enabledCheckIdsFor, lektaProfileOf } from "../../domain/index.ts";

import type { WithActor } from "../index.ts";

// SRV-1101 (C-12): the text check configuration of the institution of an
// assignment in the caller's workspace. One withActor transaction: the
// assignment must be in app.student_workspace() (the access of the work
// itself), then the institution settings the caller may read
// (settings.read_institution_values, SRV-7E: a student sees only lekta.profile
// and citation.style). Nothing of any work is read.
// INT-31: a mentored assignment (no course) is in the sibling workspace.
const IN_WORKSPACE = `SELECT 1 FROM app.student_workspace() WHERE assignment_id = $1::uuid
  UNION ALL SELECT 1 FROM app.student_mentored_workspace() WHERE assignment_id = $1::uuid`;
const SETTINGS = "SELECT key, value FROM settings.read_institution_values()";

export type TextCheckConfig = { enabledCheckIds: string[]; lektaProfileId: string | null };

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
    return { enabledCheckIds: enabledCheckIdsFor(lektaProfileId), lektaProfileId };
  });
}
