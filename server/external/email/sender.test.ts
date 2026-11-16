// S-1E-c (DAN-837): the email port behind the outside-service pattern. Invented values only.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createExternalCaller } from "../../metrics/index.ts";
import { EMAIL_ERRORS, EMAIL_UNAVAILABLE, guardEmail, type EmailSender } from "./sender.ts";

const POLICY = { timeoutMs: 1000, retries: 3, retryDelayMs: 0, downAfter: 9, downForMs: 0 };
const MESSAGE = { to: "student-a@primjer.invalid", template: "invite", values: {} };
const hr = JSON.parse(
  readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
) as {
  email?: Record<string, unknown>;
};

describe("guardEmail", () => {
  it("has a Croatian text for every error key", () => {
    for (const error of EMAIL_ERRORS) {
      const text = hr.email?.[error.messageKey.replace(/^email\./, "")];
      expect(typeof text === "string" && text.trim() !== "", error.messageKey).toBe(true);
    }
  });

  it("sends at most once, even when the service fails", async () => {
    let calls = 0;
    const sender: EmailSender = {
      send: async () => ((calls += 1), { status: "unavailable" }),
    };
    const result = await guardEmail(sender, createExternalCaller("email", POLICY)).send(MESSAGE);
    expect(result).toEqual({ ok: false, error: EMAIL_UNAVAILABLE });
    expect(calls).toBe(1);
  });

  it("hands the service an abort signal and answers sent", async () => {
    let seen: AbortSignal | undefined;
    const sender: EmailSender = {
      send: async (_m, signal) => ((seen = signal), { status: "sent" }),
    };
    expect(await guardEmail(sender, createExternalCaller("email", POLICY)).send(MESSAGE)).toEqual({
      ok: true,
    });
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
