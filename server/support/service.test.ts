// DAN-851-2c2 (contract Ductus#1836 c.6946151955): the support service hands
// the port only a valid UTF-8, canonical JSON body that parseProblemReport
// accepts, and exactly the parser's value; every other body is refused before
// the port. The cases port Ductus problem-report-route.test.ts at 81833ca.
// Every token, text and reference below is invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProblemReportStore } from "../database/index.ts";
import {
  type AppError,
  canonicalizeJcs,
  PROBLEM_REPORT_DESCRIPTION_MAX,
  parseProblemReport,
  type ProblemReport,
  type Result,
} from "../domain/index.ts";

import {
  createSupportService,
  PROBLEM_REPORT_INVALID_BODY,
  PROBLEM_REPORT_INVALID_JSON,
  SUPPORT_ERRORS,
} from "./service.ts";

const TOKEN = "izmisljeni-token-prijave-000000000000000002";
const REFERENCE = "PR-0A1B2C3D4E";
// Invented text standing in for a student's work; it must never reach the port.
const CANARY = "kanarinac-rad-7f3d Prvi odlomak rada o regionalnoj politici";
const BS = "\\";
const char = (code: number) => String.fromCodePoint(code);

type Vector = { name: string; request: { body?: unknown; rawBody?: string } };
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/support.problem-report.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => {
  const found = VECTORS.find((v) => v.name === name);
  if (!found) throw new Error(`no vector ${name}`);
  return found.request;
};

// The Ductus VALID body.
const VALID = {
  appVersion: "1.4.0+0a1b2c3",
  browser: { family: "firefox", major: 132 },
  category: "technical",
  description: "Gumb za predaju ne reagira nakon spremanja.",
  route: "/rad/[assignmentId]/predaja",
  syncState: "SYNCING",
};
const CANONICAL = canonicalizeJcs(VALID);

// Invented port errors: the service test imports no value from database.
const PORT_ERRORS: AppError[] = [
  { code: "PORT_UNAUTHENTICATED", messageKey: "port.unauthenticated" },
  { code: "PORT_DATABASE_ERROR", messageKey: "port.database_error" },
];

function fake(answer: Result<string> = { ok: true, value: REFERENCE }) {
  const calls: [string, ProblemReport][] = [];
  const store: ProblemReportStore = {
    submit: async (token, report) => {
      calls.push([token, report]);
      return answer;
    },
  };
  return { service: createSupportService({ store }), calls };
}

const encode = (text: string) => new TextEncoder().encode(text);
const fail = (error: AppError) => ({ ok: false, error });

async function refused(input: Uint8Array | string, error: AppError) {
  const { service, calls } = fake();
  const outcome = await service.submitProblemReport(
    TOKEN,
    typeof input === "string" ? encode(input) : input,
  );
  expect(outcome).toEqual(fail(error));
  expect(calls).toEqual([]);
  expect(JSON.stringify(outcome)).not.toContain("kanarinac");
}

afterEach(() => vi.restoreAllMocks());

describe("support service errors (docs/CODE_STYLE.md §8)", () => {
  const catalogue: unknown = JSON.parse(
    readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
  );
  const lookup = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        catalogue,
      );

  it("has a Croatian text for both errors, with distinct codes and keys", () => {
    expect(SUPPORT_ERRORS).toEqual([PROBLEM_REPORT_INVALID_JSON, PROBLEM_REPORT_INVALID_BODY]);
    for (const error of SUPPORT_ERRORS) {
      const text = lookup(error.messageKey);
      expect(typeof text === "string" && text.trim().length > 0, error.messageKey).toBe(true);
    }
    const all = [...SUPPORT_ERRORS, ...PORT_ERRORS];
    expect(new Set(all.map((e) => e.code)).size).toBe(all.length);
    expect(new Set(all.map((e) => e.messageKey)).size).toBe(all.length);
  });
});

describe("support service: not UTF-8 or not JSON is invalid_json", () => {
  const withBytes = (bytes: number[]) => {
    const parts = CANONICAL.split("predaju ne");
    expect(parts).toHaveLength(2);
    const [before, after] = parts as [string, string];
    return new Uint8Array([...encode(`${before}predaju`), ...bytes, ...encode(` ne${after}`)]);
  };

  it.each([
    ["0xFF", [0xff]],
    ["an overlong 0xC0 0x80", [0xc0, 0x80]],
    ["an encoded surrogate", [0xed, 0xa0, 0x80]],
    ["a cut four-byte character", [0xf0, 0x9f, 0x98]],
  ])("%s inside the description of a canonical report", async (_name, bytes) => {
    await refused(withBytes(bytes), PROBLEM_REPORT_INVALID_JSON);
  });

  it("a byte order mark before a valid body", async () => {
    await refused(
      new Uint8Array([0xef, 0xbb, 0xbf, ...encode(CANONICAL)]),
      PROBLEM_REPORT_INVALID_JSON,
    );
  });

  it.each([
    ["the invalid-json vector", vector("invalid-json").rawBody ?? ""],
    ["an empty body", ""],
    ["text that is not JSON", `opis: ${CANARY}`],
  ])("%s", async (_name, text) => {
    await refused(text, PROBLEM_REPORT_INVALID_JSON);
  });
});

describe("support service: not canonical is invalid_body", () => {
  const deep = `${"[".repeat(300)}${"]".repeat(300)}`;
  it.each([
    ["the not-canonical vector", vector("not-canonical").rawBody ?? ""],
    ["pretty printed", JSON.stringify(VALID, null, 2)],
    ["keys in another order", JSON.stringify(Object.fromEntries(Object.entries(VALID).reverse()))],
    ["a space after a comma", CANONICAL.replace(/,"/g, ', "')],
    ["a CRLF between tokens", CANONICAL.replace(',"category"', ',\r\n"category"')],
    ["a tab between tokens", CANONICAL.replace(',"category"', ',\t"category"')],
    ["a letter as a unicode escape", CANONICAL.replace('"technical"', `"${BS}u0074echnical"`)],
    ["140.0 for 140", CANONICAL.replace(":132", ":132.0")],
    [
      "a duplicate key whose first value is the canary",
      CANONICAL.replace('{"appVersion"', `{"description":"${CANARY}","appVersion"`),
    ],
    ["a lone surrogate escape in the description", CANONICAL.replace("Gumb", `${BS}ud800Gumb`)],
    ["a lone surrogate escape in a key", CANONICAL.replace("}", `,"${BS}ud800":1}`)],
    ["a number that is not finite", CANONICAL.replace(":132", ":1e400")],
    ["nesting deeper than 256", CANONICAL.replace('"route"', `"x":${deep},"route"`)],
  ])("%s", async (_name, text) => {
    await refused(text, PROBLEM_REPORT_INVALID_BODY);
  });
});

describe("support service: what the domain refuses is invalid_body", () => {
  const body = (value: unknown) => canonicalizeJcs(value);

  it("the invalid-input vector", async () => {
    await refused(body(vector("invalid-input").body), PROBLEM_REPORT_INVALID_BODY);
  });

  it.each([
    "title",
    "content",
    "paragraphs",
    "journal",
    "text",
    "document",
    "assignmentId",
    "userId",
    "institutionId",
  ])("a key %s with work text", async (key) => {
    await refused(body({ ...VALID, [key]: CANARY }), PROBLEM_REPORT_INVALID_BODY);
  });

  it.each([
    ["route", { route: `/rad/${CANARY}` }],
    ["route as a real path", { route: "/rad/11111111-1111-4111-8111-111111111111/predaja" }],
    ["app version", { appVersion: CANARY }],
    ["category", { category: CANARY }],
    ["sync state", { syncState: CANARY }],
    ["browser family", { browser: { family: CANARY, major: 1 } }],
    ["browser major as text", { browser: { family: "safari", major: CANARY } }],
    ["a key inside browser", { browser: { family: "safari", major: 1, title: CANARY } }],
    ["a nested object as description", { description: { paragraphs: [CANARY] } }],
    ["an array as description", { description: [CANARY] }],
  ])("work text in the %s", async (_name, change) => {
    await refused(body({ ...VALID, ...change }), PROBLEM_REPORT_INVALID_BODY);
  });

  it.each([
    ["over the limit", "x".repeat(PROBLEM_REPORT_DESCRIPTION_MAX + 1)],
    ["only white space", " \n\t "],
    ["empty", ""],
    ["only a no-break space", char(0xa0)],
    ["with DEL", `a${char(0x7f)}b`],
    ["with CR", "a\rb"],
    ["with a bidi override", `a${char(0x202e)}b`],
  ])("a description %s", async (_name, description) => {
    await refused(body({ ...VALID, description }), PROBLEM_REPORT_INVALID_BODY);
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a number", "1"],
    ["a string", `"${CANARY}"`],
  ])("a body that is %s", async (_name, text) => {
    await refused(text, PROBLEM_REPORT_INVALID_BODY);
  });
});

describe("support service: a valid report reaches the port once", () => {
  const four = char(0x1f600);
  it.each([
    ["the recorded vector", vector("recorded").body],
    ["the recorded-without-context vector", vector("recorded-without-context").body],
    ["the largest context", { ...VALID, description: four.repeat(PROBLEM_REPORT_DESCRIPTION_MAX) }],
    [
      "a no-break space beside visible text and a line feed",
      { ...VALID, description: `a${char(0xa0)}b\nc` },
    ],
  ])("%s gives the port the token and the parser's value", async (_name, value) => {
    const { service, calls } = fake();
    expect(await service.submitProblemReport(TOKEN, encode(canonicalizeJcs(value)))).toEqual({
      ok: true,
      value: REFERENCE,
    });
    expect(calls).toEqual([[TOKEN, parseProblemReport(value)]]);
  });

  it("the port's outcome comes back as it is", async () => {
    for (const answer of [
      { ok: true as const, value: "PR-FFFFFFFFFF" },
      ...PORT_ERRORS.map((error) => ({ ok: false as const, error })),
    ]) {
      const { service } = fake(answer);
      expect(await service.submitProblemReport(TOKEN, encode(CANONICAL))).toBe(answer);
    }
  });

  it("logs nothing, for a refusal or a report", async () => {
    const spies = ["error", "warn", "log", "info"].map((name) =>
      vi.spyOn(console, name as "error"),
    );
    const { service } = fake();
    await service.submitProblemReport(TOKEN, encode(`{"title":"${CANARY}"}`));
    await service.submitProblemReport(TOKEN, encode(CANONICAL));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
