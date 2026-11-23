// The faculty's assistant setting on the dev fake server
// (institution.assistant-setting.get, SRV-ADMIN-3; NF-7 OA-9, OC-1). Only the
// administrator reads it; it never changes. The values are invented and match
// the local demo faculty: the assistant answers (the fake has its own
// assistant routes), both flags of the faculty switch are off, setting
// version 1. No provider and no model is named.
import type { Handlers } from "./server.ts";

export const ASSISTANT_SETTING_HANDLERS: Handlers = {
  "institution.assistant-setting.get": ({ account, header, query }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("institution_admin")) return { error: "forbidden" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    return {
      status: 200,
      body: {
        assistant: true,
        transcription: false,
        tools: false,
        settingVersion: 1,
        changeable: false,
      },
    };
  },
};
