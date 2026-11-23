import type { WithActor } from "../database/index.ts";

/**
 * SRV-ADMIN-3 (Ductus#2055; NF-7 OA-9, owner decisions of 23. 11. 2026., item
 * 6, and OC-1 of 21. 11. 2026.): the assistant setting of the administrator's
 * faculty, read only. One statement in a withActor transaction tells whether
 * the session is open (app.current_actor(), 401 when it is not), whether the
 * caller is a confirmed administrator (institution.actor_has_role('admin'),
 * notFound otherwise, as the other administrator reads) and the slug of the
 * session's institution. The switch itself comes from the versioned faculty
 * setting the composition read once (config/faculties/<faculty>.json); nothing
 * here or anywhere else changes it. No provider and no model is named.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The part of a faculty setting this read shows; null when the faculty has none. */
export type FacultyAssistantSwitch = {
  readonly version: number;
  readonly transcription: boolean;
  readonly tools: boolean;
};

export type AssistantSettingSource = {
  /** The switch of the faculty with this slug, or null without a setting (all off). */
  readonly switchOf: (institutionSlug: string | null) => FacultyAssistantSwitch | null;
  /** The assistant answers on this server: a provider configuration is loaded. */
  readonly assistant: boolean;
};

export type AssistantSettingView = {
  assistant: boolean;
  transcription: boolean;
  tools: boolean;
  settingVersion: number | null;
  changeable: false;
};

export type AssistantSettingRead =
  | { kind: "ok"; setting: AssistantSettingView }
  | { kind: "unauthorized" | "notFound" | "unavailable" };

type Row = Record<string, unknown>;

const QUERY = `SELECT (SELECT a.user_id FROM app.current_actor() a) IS NOT NULL AS authenticated,
    institution.actor_has_role('admin') AS admin,
    app.current_institution_slug() AS "institutionSlug"`;

function codeOf(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}

/** The view of a faculty switch; no setting is both flags off and no version. */
export function assistantSettingOf(
  facultySwitch: FacultyAssistantSwitch | null,
  assistant: boolean,
): AssistantSettingView {
  return {
    assistant,
    transcription: facultySwitch?.transcription ?? false,
    tools: facultySwitch?.tools ?? false,
    settingVersion: facultySwitch?.version ?? null,
    changeable: false,
  };
}

export async function readAssistantSetting(
  sessionToken: string | undefined,
  withActor: WithActor,
  source: AssistantSettingSource,
): Promise<AssistantSettingRead> {
  if (sessionToken === undefined || !TOKEN.test(sessionToken)) return { kind: "unauthorized" };
  let rows: Row[];
  try {
    rows = await withActor(sessionToken, async (tx) => (await tx.query<Row>(QUERY)).rows);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ZD401") return { kind: "unauthorized" };
    if (code === "ZD403") return { kind: "notFound" };
    console.error(
      "assistant setting read failed",
      code !== undefined && SQLSTATE.test(code) ? code : "unknown",
    );
    return { kind: "unavailable" };
  }
  const row = rows.length === 1 ? rows[0]! : undefined;
  if (row?.authenticated === false) return { kind: "unauthorized" };
  if (row?.authenticated !== true || typeof row.admin !== "boolean") {
    console.error("assistant setting read failed", "row_malformed");
    return { kind: "unavailable" };
  }
  if (!row.admin) return { kind: "notFound" };
  const slug = row.institutionSlug;
  if (slug !== null && typeof slug !== "string") {
    console.error("assistant setting read failed", "row_malformed");
    return { kind: "unavailable" };
  }
  return { kind: "ok", setting: assistantSettingOf(source.switchOf(slug), source.assistant) };
}
