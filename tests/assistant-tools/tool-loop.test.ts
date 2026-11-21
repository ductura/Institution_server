// The tool loop over the synthetic adapter (Ductus ai-tools-v1, "Port i
// sintetički adapter", "Granice izlaza"; plan #1664 S3-S1, S3-I1 to S3-I4,
// S3-D2, S3-O1, S3-U4). The steps of the database are played by a fake that
// keeps the contract's order of outcomes; the database itself is in
// tests/db/assistant-tools.integration.test.ts. Everything is invented. Here,
// not beside the loop: one adapter of server/external imports no other.
import { describe, expect, it } from "vitest";

import {
  decodeDataParts,
  encodeDataParts,
  RESPONSE_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
  TOOL_STEP_MAX,
  type AssistantPortInput,
  type ToolName,
} from "../../server/domain/index.ts";
import {
  createSyntheticAssistant,
  type SyntheticBranch,
} from "../../server/external/assistant/index.ts";
import {
  createSearchGuard,
  NO_TRANSPORT,
  runToolLoop,
  type BeginStep,
  type SearchTransport,
  type ToolLoopInput,
} from "../../server/external/assistant-tools/index.ts";
import { SYNTHETIC_TOOL_SAMPLES } from "../../test-support/assistant-tools/index.ts";

const INSTRUCTIONS = "Upute poslužitelja za svrhu literature_search (izmišljeno).";
const PARAGRAPH = "Izmišljeni odlomak o kućnom kompostiranju u gradu.";
const DESTINATION = {
  id: "trazilica-a",
  endpoint: "https://trazilica-a.invalid/search",
  queryParameter: "q",
};

const search = (query: string) => ({ name: "web_search", args: { query } });

/** The database side: the order of outcomes, the bound and revocation. */
function fakeSteps(
  options: { allowed?: readonly ToolName[]; revokeAfter?: number | undefined } = {},
) {
  const rows: { stepNo: number; toolName: string | null; outcome: string; finished?: string }[] =
    [];
  let allowed: readonly ToolName[] = options.allowed ?? ["web_search"];
  const beginStep: BeginStep = (step) => {
    if (step.stepNo !== rows.length + 1 || step.stepNo > TOOL_STEP_MAX)
      return Promise.resolve({ status: "refused" });
    if (options.revokeAfter !== undefined && rows.length >= options.revokeAfter) allowed = [];
    const outcome = !allowed.includes("web_search")
      ? "denied_revoked"
      : step.toolName === null || !allowed.includes(step.toolName)
        ? "denied_not_in_set"
        : !step.argsValid
          ? "denied_schema"
          : "allowed";
    rows.push({ stepNo: step.stepNo, toolName: step.toolName, outcome });
    return Promise.resolve({
      status: "ok",
      outcome,
      tools: outcome === "denied_revoked" ? [] : allowed,
    });
  };
  const finishStep = (finish: { stepNo: number; outcome: "done" | "failed" }) => {
    const row = rows[finish.stepNo - 1];
    if (row === undefined || row.outcome !== "allowed" || row.finished !== undefined)
      return Promise.resolve(false);
    row.finished = finish.outcome;
    return Promise.resolve(true);
  };
  return { rows, beginStep, finishStep };
}

function transport(body: string): SearchTransport & { gets: number } {
  const state = {
    gets: 0,
    resolve: () => Promise.resolve(["93.184.216.34"]),
    get: (request: { url: string; maxBytes: number }) => {
      state.gets += 1;
      const over = new TextEncoder().encode(body).byteLength > request.maxBytes;
      return Promise.resolve({ status: 200, text: body, overflow: over });
    },
  };
  return state;
}

function setup(
  script: SyntheticBranch | readonly SyntheticBranch[],
  options: {
    tools?: readonly ToolName[];
    body?: string;
    destinations?: boolean;
    revokeAfter?: number;
  } = {},
) {
  const port = createSyntheticAssistant(script);
  const steps = fakeSteps({ revokeAfter: options.revokeAfter });
  const net = transport(options.body ?? "Izmišljeni rezultat pretrage.");
  const guard = createSearchGuard({
    destinations: options.destinations === false ? [] : [DESTINATION],
    transport: options.destinations === false ? NO_TRANSPORT : net,
  });
  const input: ToolLoopInput = {
    instructions: INSTRUCTIONS,
    history: [],
    paragraph: PARAGRAPH,
    purposeKey: "literature_search",
    modelId: "model-test-1",
    tools: options.tools ?? ["web_search"],
  };
  const run = () =>
    runToolLoop(
      {
        callPort: (i) => port.complete(i),
        beginStep: steps.beginStep,
        finishStep: steps.finishStep,
        guard,
      },
      input,
    );
  return { port, steps, net, run };
}

const kinds = (calls: readonly AssistantPortInput[]) => calls.map((c) => c.data.map((p) => p.kind));

describe("one call without tools (the pilot)", () => {
  it("offers no tool and stores the answer at its cost", async () => {
    const { port, run } = setup(
      { branch: "success", actualMicro: 3n, text: "Izmišljeni odgovor." },
      { tools: [] },
    );
    expect(await run()).toEqual({ kind: "success", text: "Izmišljeni odgovor.", totalMicro: 3n });
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.tools).toEqual([]);
  });

  it("a tool request of a request without a loop ends with tool_step_limit, no second call", async () => {
    const { port, steps, run } = setup({ branch: "endless_tools", actualMicro: 2n }, { tools: [] });
    expect(await run()).toEqual({ kind: "tool_step_limit", totalMicro: 2n });
    expect(port.calls).toHaveLength(1);
    expect(steps.rows).toEqual([]);
  });
});

describe("the loop (S3-S1)", () => {
  it("runs web_search through the guard and hands the result back as one tool_result part", async () => {
    const { port, steps, net, run } = setup([
      { branch: "tool_calls", calls: [search("kompostiranje")], actualMicro: 2n },
      { branch: "success", actualMicro: 3n, text: "Izmišljeni odgovor s izvorima." },
    ]);
    expect(await run()).toEqual({
      kind: "success",
      text: "Izmišljeni odgovor s izvorima.",
      totalMicro: 5n,
    });
    expect(net.gets).toBe(1);
    expect(steps.rows).toEqual([
      { stepNo: 1, toolName: "web_search", outcome: "allowed", finished: "done" },
    ]);
    expect(kinds(port.calls)).toEqual([["paragraph"], ["paragraph", "tool_result"]]);
    expect(port.calls[1]!.data[1]).toEqual({
      kind: "tool_result",
      text: "Izmišljeni rezultat pretrage.",
      truncated: false,
    });
    // The instructions never change and never carry data (S3-U4, S3-O1).
    for (const call of port.calls) {
      expect(call.instructions).toBe(INSTRUCTIONS);
      expect(call.tools.map((t) => t.name)).toEqual(["web_search"]);
    }
  });

  it("an endless loop stops at TOOL_STEP_MAX with tool_step_limit and no further call", async () => {
    const { port, steps, run } = setup({ branch: "endless_tools", actualMicro: 1n });
    expect(await run()).toEqual({ kind: "tool_step_limit", totalMicro: BigInt(TOOL_STEP_MAX + 1) });
    expect(steps.rows).toHaveLength(TOOL_STEP_MAX);
    expect(port.calls).toHaveLength(TOOL_STEP_MAX + 1);
  });

  it("several calls in one output are several steps; more than remain run none of them", async () => {
    const { port, steps, run } = setup([
      { branch: "tool_calls", calls: [search("a"), search("b")], actualMicro: 1n },
      { branch: "tool_calls", calls: [search("c"), search("d")], actualMicro: 1n },
    ]);
    expect(await run()).toEqual({ kind: "tool_step_limit", totalMicro: 2n });
    expect(steps.rows.map((r) => r.stepNo)).toEqual([1, 2]);
    expect(port.calls).toHaveLength(2);
  });

  it("look-alike names are denied_not_in_set and go back as tool_denied codes; nothing runs", async () => {
    const { port, steps, net, run } = setup([
      ...SYNTHETIC_TOOL_SAMPLES.lookAlikeNames
        .slice(0, TOOL_STEP_MAX)
        .map((name): SyntheticBranch => ({
          branch: "tool_calls",
          calls: [{ name, args: { query: "x" } }],
          actualMicro: 1n,
        })),
      { branch: "success", actualMicro: 1n },
    ]);
    expect((await run()).kind).toBe("success");
    expect(steps.rows.every((r) => r.outcome === "denied_not_in_set" && r.toolName === null)).toBe(
      true,
    );
    expect(net.gets).toBe(0);
    const last = port.calls.at(-1)!;
    expect(last.data.filter((p) => p.kind === "tool_denied").map((p) => p.text)).toEqual(
      Array(TOOL_STEP_MAX).fill("denied_not_in_set"),
    );
    expect(JSON.stringify(last.data)).not.toContain("Web_search");
  });

  it("arguments outside the schema, also with an address, are denied_schema and never fetched", async () => {
    const bad = [
      ...SYNTHETIC_TOOL_SAMPLES.badArgs.slice(0, 2),
      { query: "x", url: "https://zlo.invalid/" },
    ];
    const { steps, net, run } = setup([
      ...bad.map((args): SyntheticBranch => ({
        branch: "tool_calls",
        calls: [{ name: "web_search", args }],
        actualMicro: 1n,
      })),
      { branch: "success", actualMicro: 1n },
    ]);
    expect((await run()).kind).toBe("success");
    expect(steps.rows.map((r) => r.outcome)).toEqual(Array(3).fill("denied_schema"));
    expect(net.gets).toBe(0);
  });

  it("an address in a valid query is only query text to the listed destination", async () => {
    const { net, run } = setup([
      { branch: "tool_calls", calls: [search("http://127.0.0.1:8080/admin")], actualMicro: 1n },
      { branch: "success", actualMicro: 1n },
    ]);
    expect((await run()).kind).toBe("success");
    expect(net.gets).toBe(1);
  });

  it("a result with a forged fence stays one tool_result part and the round trip holds", async () => {
    const { port, run } = setup(
      [
        { branch: "tool_calls", calls: [search("x")], actualMicro: 1n },
        { branch: "success", actualMicro: 1n },
      ],
      { body: SYNTHETIC_TOOL_SAMPLES.forgedFence },
    );
    await run();
    const data = port.calls[1]!.data;
    expect(data.map((p) => p.kind)).toEqual(["paragraph", "tool_result"]);
    expect(decodeDataParts(encodeDataParts(data))).toEqual(data);
    expect(port.calls[1]!.instructions).toBe(INSTRUCTIONS);
  });

  it("a result above TOOL_RESULT_MAX_BYTES is cut on a code point with truncated set by the server", async () => {
    const { port, steps, run } = setup(
      [
        { branch: "tool_calls", calls: [search("x")], actualMicro: 1n },
        { branch: "success", actualMicro: 1n },
      ],
      { body: "č".repeat(TOOL_RESULT_MAX_BYTES) },
    );
    await run();
    const part = port.calls[1]!.data[1]!;
    expect(part.truncated).toBe(true);
    expect(new TextEncoder().encode(part.text).length).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(steps.rows[0]!.finished).toBe("done");
  });

  it("with no destination (the pilot's list) an allowed step fails and nothing connects", async () => {
    const { port, steps, run } = setup(
      [
        { branch: "tool_calls", calls: [search("x")], actualMicro: 1n },
        { branch: "success", actualMicro: 1n },
      ],
      { destinations: false },
    );
    expect((await run()).kind).toBe("success");
    expect(steps.rows[0]!.finished).toBe("failed");
    expect(port.calls[1]!.data[1]).toEqual({
      kind: "tool_denied",
      text: "failed",
      truncated: false,
    });
  });
});

describe("revocation and bounds", () => {
  it("a revoked step ends the request with request_revoked and no further call (S3-Z1)", async () => {
    const { port, steps, run } = setup(
      { branch: "endless_tools", actualMicro: 4n },
      { revokeAfter: 1 },
    );
    expect(await run()).toEqual({ kind: "request_revoked", totalMicro: 8n });
    expect(steps.rows.map((r) => r.outcome)).toEqual(["allowed", "denied_revoked"]);
    expect(port.calls).toHaveLength(2);
  });

  it("an answer above RESPONSE_MAX_BYTES is response_too_large and not returned (S3-I3)", async () => {
    const { run } = setup({ branch: "oversized_response", actualMicro: 2n });
    expect(await run()).toEqual({ kind: "response_too_large", totalMicro: 2n });
    const atBound = setup({
      branch: "success",
      actualMicro: 2n,
      text: "a".repeat(RESPONSE_MAX_BYTES),
    });
    expect((await atBound.run()).kind).toBe("success");
  });

  it("an answer with HTML, an image and a link is returned as plain text, unchanged", async () => {
    const { run } = setup({
      branch: "success",
      actualMicro: 1n,
      text: SYNTHETIC_TOOL_SAMPLES.htmlAnswer,
    });
    expect(await run()).toEqual({
      kind: "success",
      text: SYNTHETIC_TOOL_SAMPLES.htmlAnswer,
      totalMicro: 1n,
    });
  });

  it("an answer that reads like a command runs nothing (S3-I4)", async () => {
    const { port, steps, net, run } = setup({
      branch: "success",
      actualMicro: 1n,
      text: SYNTHETIC_TOOL_SAMPLES.commandAnswer,
    });
    expect((await run()).kind).toBe("success");
    expect(steps.rows).toEqual([]);
    expect(net.gets).toBe(0);
    expect(port.calls).toHaveLength(1);
  });

  it("a timeout or an abort is unknown; a provider error carries the cost so far", async () => {
    expect(await setup({ branch: "timeout" }).run()).toEqual({ kind: "unknown" });
    expect(await setup({ branch: "aborted_after_send" }).run()).toEqual({ kind: "unknown" });
    expect(
      await setup([
        { branch: "tool_calls", calls: [search("x")], actualMicro: 2n },
        { branch: "provider_error", actualMicro: 1n },
      ]).run(),
    ).toEqual({ kind: "provider_error", totalMicro: 3n });
    expect(await setup({ branch: "provider_error" }).run()).toEqual({
      kind: "provider_error",
      totalMicro: null,
    });
  });

  it("a step the database refuses ends as unknown, with no further call", async () => {
    const port = createSyntheticAssistant({ branch: "endless_tools", actualMicro: 1n });
    const result = await runToolLoop(
      {
        callPort: (i) => port.complete(i),
        beginStep: () => Promise.resolve({ status: "refused" }),
        finishStep: () => Promise.resolve(true),
        guard: createSearchGuard({ destinations: [], transport: NO_TRANSPORT }),
      },
      {
        instructions: INSTRUCTIONS,
        history: [],
        paragraph: PARAGRAPH,
        purposeKey: "literature_search",
        modelId: "model-test-1",
        tools: ["web_search"],
      },
    );
    expect(result).toEqual({ kind: "unknown" });
    expect(port.calls).toHaveLength(1);
  });
});
