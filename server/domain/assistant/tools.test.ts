// Unit tests for the closed tool set of ai-tools-v1 step 1 (plan #1664
// S3-D1 to S3-D4, S3-D6, S3-N2). All queries and destinations are invented.
import { describe, expect, it } from "vitest";

import { aiSwitchOf, serverPermittedTools } from "./faculty-ai-config.ts";
import {
  AI_SWITCH_OFF,
  allowedTools,
  CODE_TOOLS,
  makeAiSwitchReader,
  matchToolName,
  parseAssignmentTools,
  QUERY_MAX,
  readyTools,
  validateToolArgs,
} from "./tools.ts";

const INSTITUTION = "7c1e4b2a-9d3f-4e5a-8b6c-0d1e2f3a4b5c";
const DESTINATION = "search-test-a.invalid";

describe("CODE_TOOLS", () => {
  it("has exactly web_search", () => {
    expect(CODE_TOOLS).toEqual(["web_search"]);
  });
});

describe("matchToolName (S3-D3)", () => {
  it("matches the exact bytes only", () => {
    expect(matchToolName("web_search")).toBe("web_search");
    for (const near of [
      "Web_search",
      "WEB_SEARCH",
      " web_search",
      "web_search ",
      "web-search",
      "web_search​",
      "ｗｅｂ_search",
      "web_searc",
      "code_execution",
      "",
    ])
      expect(matchToolName(near)).toBeNull();
    expect(matchToolName(undefined)).toBeNull();
    expect(matchToolName(["web_search"])).toBeNull();
  });
});

describe("validateToolArgs (S3-D4, S3-N2)", () => {
  it("accepts exactly one query key with 1 to QUERY_MAX code points", () => {
    expect(validateToolArgs("web_search", { query: "lokalni izbori" })).toEqual({
      ok: true,
      args: { query: "lokalni izbori" },
    });
    expect(validateToolArgs("web_search", { query: "q" })).toMatchObject({ ok: true });
  });

  it("counts code points after NFC, at the limit and one over", () => {
    expect(validateToolArgs("web_search", { query: "😀".repeat(QUERY_MAX) })).toMatchObject({
      ok: true,
    });
    expect(validateToolArgs("web_search", { query: "é".repeat(QUERY_MAX) })).toEqual({
      ok: true,
      args: { query: "é".repeat(QUERY_MAX) },
    });
    expect(validateToolArgs("web_search", { query: "a".repeat(QUERY_MAX + 1) })).toEqual({
      ok: false,
      outcome: "denied_schema",
      rule: "query_too_long",
    });
  });

  it("refuses an unknown key, wrong type, missing field, empty string and nested object", () => {
    const cases: [unknown, string][] = [
      [{ query: "a", url: "https://x.invalid" }, "args_unknown_key"],
      [{ destination: "x.invalid" }, "args_unknown_key"],
      [{}, "args_missing_key"],
      [{ query: 1 }, "query_not_string"],
      [{ query: null }, "query_not_string"],
      [{ query: { text: "a" } }, "query_not_string"],
      [{ query: ["a"] }, "query_not_string"],
      [{ query: "" }, "query_empty"],
      ["a", "args_not_object"],
      [null, "args_not_object"],
      [["a"], "args_not_object"],
    ];
    for (const [args, rule] of cases)
      expect(validateToolArgs("web_search", args)).toEqual({
        ok: false,
        outcome: "denied_schema",
        rule,
      });
  });

  it("treats an address in the query as query text only", () => {
    for (const query of ["http://127.0.0.1/", "https://xn--prmjer-1ua.invalid", "file:///etc/x"])
      expect(validateToolArgs("web_search", { query })).toEqual({ ok: true, args: { query } });
  });
});

describe("institution switch", () => {
  it("an institution without a faculty setting has both flags off (OC-1)", () => {
    expect(aiSwitchOf(null)).toEqual({ transcription: false, tools: false });
    expect(AI_SWITCH_OFF).toEqual({ transcription: false, tools: false });
    expect(Object.isFrozen(AI_SWITCH_OFF)).toBe(true);
  });

  it("a synthetic reader turns a flag on only for exactly true", () => {
    const read = makeAiSwitchReader((id) =>
      id === INSTITUTION ? { transcription: "true", tools: true } : 1,
    );
    expect(read(INSTITUTION)).toEqual({ transcription: false, tools: true });
    expect(read("other")).toEqual({ transcription: false, tools: false });
  });

  it("turning tools off between steps empties the next step's set", () => {
    let tools = true;
    const read = makeAiSwitchReader(() => ({ transcription: false, tools }));
    const step = (): readonly string[] =>
      allowedTools({
        institutionSwitch: read(INSTITUTION),
        assignmentTools: ["web_search"],
        ready: ["web_search"],
      });
    expect(step()).toEqual(["web_search"]);
    tools = false;
    expect(step()).toEqual([]);
  });
});

describe("readyTools", () => {
  it("search is ready only with a destination; the pilot list is empty (OC-2)", () => {
    expect(readyTools([])).toEqual([]);
    expect(readyTools([DESTINATION])).toEqual(["web_search"]);
  });

  it("no tool is offered without a setting or with the pilot's empty destination list", () => {
    expect(serverPermittedTools(null)).toEqual([]);
    expect(
      allowedTools({
        institutionSwitch: aiSwitchOf(null),
        assignmentTools: ["web_search"],
        ready: readyTools([]),
      }),
    ).toEqual([]);
  });
});

describe("allowedTools (S3-D1)", () => {
  it("offers web_search only when every condition holds, over all combinations", () => {
    const toolLists: readonly string[][] = [[], ["web_search"], ["Web_search"], ["code_execution"]];
    for (const transcription of [false, true])
      for (const switchTools of [false, true])
        for (const assignmentTools of toolLists)
          for (const destinations of [[], [DESTINATION]]) {
            const result = allowedTools({
              institutionSwitch: { transcription, tools: switchTools },
              assignmentTools,
              ready: readyTools(destinations),
            });
            const expected =
              switchTools && assignmentTools.includes("web_search") && destinations.length > 0;
            expect(result).toEqual(expected ? ["web_search"] : []);
          }
  });

  it("never offers a tool outside the code set, even if every list names it", () => {
    expect(
      allowedTools({
        institutionSwitch: { transcription: true, tools: true },
        assignmentTools: ["code_execution", "web_search"],
        ready: ["code_execution", "web_search"],
      }),
    ).toEqual(["web_search"]);
  });
});

describe("parseAssignmentTools", () => {
  it("accepts distinct code tools only", () => {
    expect(parseAssignmentTools([])).toEqual({ ok: true, tools: [] });
    expect(parseAssignmentTools(["web_search"])).toEqual({ ok: true, tools: ["web_search"] });
    for (const value of [
      ["web_search", "web_search"],
      ["Web_search"],
      ["code_execution"],
      [["web_search"]],
      "web_search",
      null,
    ])
      expect(parseAssignmentTools(value)).toEqual({ ok: false, outcome: "invalid_request" });
  });
});
