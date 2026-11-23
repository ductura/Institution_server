import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-ADMIN-3 (Ductus#2055; NF-7 OA-9, owner decisions of 23. 11. 2026., item
// 6, and OC-1 of 21. 11. 2026.): the assistant setting of the faculty, read
// only, for an administrator of the institution. The switch lives in the
// versioned faculty setting config/faculties/<faculty>.json and changes only
// through a PR the owner approves; nothing on this route or any other route
// changes it. The answer never names a provider or a model (Q-10).

export const AssistantSetting = closed({
  /**
   * The assistant answers requests on this server: a provider configuration
   * is loaded (no provider and no model is named). The same for every faculty
   * of the server; the teacher still decides per assignment.
   */
  assistant: Type.Boolean(),
  /** The faculty switch (OC-1): transcription allowed. */
  transcription: Type.Boolean(),
  /** The faculty switch (OC-1): tools allowed. */
  tools: Type.Boolean(),
  /** The version of the faculty setting; null when the faculty has none (all off). */
  settingVersion: Type.Union([Type.Integer({ minimum: 1, maximum: 2_147_483_647 }), Type.Null()]),
  /** Never changeable from the application (OC-1). */
  changeable: Type.Literal(false),
});
export type AssistantSetting = Static<typeof AssistantSetting>;

export const assistantSettingGet = defineRoute({
  id: "institution.assistant-setting.get",
  method: "GET",
  path: "/api/v1/institution/assistant-setting",
  inventory: "app/api/institution/assistant-setting/route.ts",
  access: "institution_admin",
  summary:
    "The assistant setting of the caller's faculty for a confirmed administrator of its institution, read only: assistant (the assistant answers on this server; no provider or model is ever named), the two flags of the faculty switch (transcription, tools) from the versioned faculty setting, its settingVersion (null when the faculty has no setting: both flags off) and changeable, always false: the switch changes only through the owner's PR, never from a screen (OC-1). No query: any query parameter is 422. A teacher, a student and an account without a confirmed administrator role are 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the assistant setting of the faculty",
      body: AssistantSetting,
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const assistantSettingRoutes = [assistantSettingGet] as const;
