// SRV-1812 (plan M11.3): the startup lines are structured JSON of server/log.
// A refused environment names the variable, never its value; a failed start
// names its code. Acceptance (2) and (3): no e-mail address, no text of a
// work and no secret reaches a line, whatever the error carries. Every value
// below is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createLogger, type LogEvent } from "../log/index.ts";

import { logStartupFailed, logStartupRefused } from "./startup-log.ts";

const EMAIL = "izmisljeni.nastavnik@fakultet.invalid";
const WORK_TEXT = "Zaključak: izmišljeni grad kompostira pola otpada";
const SECRET = "izmisljena-lozinka-baze-9f2c";

function capture(): { log: LogEvent; lines: () => Record<string, unknown>[]; raw: () => string } {
  const lines: string[] = [];
  return {
    log: createLogger(
      (_level, line) => lines.push(line),
      () => new Date(0),
    ),
    lines: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join("\n"),
  };
}

describe("logStartupRefused", () => {
  it("writes one startup.refused line per problem, with the variable name", () => {
    const { log, lines } = capture();
    logStartupRefused(["APP_DATABASE_URL is not set", "PORT is not a port number"], log);
    expect(lines()).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "error",
        event: "startup.refused",
        fields: { problem: "APP_DATABASE_URL is not set" },
      },
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "error",
        event: "startup.refused",
        fields: { problem: "PORT is not a port number" },
      },
    ]);
  });

  it("writes nothing for no problem", () => {
    const { log, lines } = capture();
    logStartupRefused([], log);
    expect(lines()).toEqual([]);
  });
});

describe("logStartupFailed", () => {
  it("names the system code only, never the message", () => {
    const { log, lines, raw } = capture();
    logStartupFailed(
      Object.assign(new Error(`listen ${EMAIL} ${SECRET}`), { code: "EADDRINUSE" }),
      log,
    );
    expect(lines()).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "error",
        event: "startup.failed",
        fields: { code: "EADDRINUSE" },
      },
    ]);
    expect(raw()).not.toContain(SECRET);
  });

  it("passes a message without a code through redact: no e-mail, no text of a work, no secret", () => {
    const { log, lines, raw } = capture();
    logStartupFailed(new Error(`route table: ${EMAIL} password=${SECRET} text=${WORK_TEXT}`), log);
    expect(lines()[0]).toMatchObject({ level: "error", event: "startup.failed" });
    for (const part of [EMAIL, "@", SECRET, WORK_TEXT, "kompostira"])
      expect(raw()).not.toContain(part);
  });

  it.each([[null], [undefined], ["text"], [42]])("survives %s as the error", (error) => {
    const { log, lines } = capture();
    logStartupFailed(error, log);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "startup.failed", fields: { message: "" } }),
    ]);
  });

  it("survives an error whose getter throws", () => {
    const { log, lines } = capture();
    const hostile = Object.defineProperty({}, "code", {
      get() {
        throw new Error(SECRET);
      },
    });
    logStartupFailed(hostile, log);
    expect(lines()).toEqual([
      expect.objectContaining({ event: "startup.failed", fields: { message: "" } }),
    ]);
  });
});

// Acceptance (3): the examples of the operations guide hold no secret: every
// JSON example parses as a startup line naming a variable, and no URL carries
// a user or a password.
describe("docs/OPERATIONS.md", () => {
  const text = readFileSync(new URL("../../docs/OPERATIONS.md", import.meta.url), "utf8");

  it("has no URL with credentials and no assignment of a secret-like value", () => {
    expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/iu);
    expect(text).not.toMatch(/(?:SECRET|TOKEN|PASSWORD|_URL)\s*[=:]\s*["']?[^\s"'`|<]{6,}/u);
  });

  it("shows startup lines that name a variable, never a value", () => {
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/gu)].map((m) => m[1] ?? "");
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const line = JSON.parse(block) as { event: string; fields: { problem: string } };
      expect(line.event).toBe("startup.refused");
      expect(line.fields.problem).toMatch(/^[A-Z][A-Z0-9_]+ is /u);
    }
  });

  it("documents the exit code of a refused environment", () => {
    expect(text).toContain("| `78`");
  });
});
