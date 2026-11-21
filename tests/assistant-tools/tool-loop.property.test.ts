// Properties of the tool loop over any script of the synthetic adapter
// (Ductus ai-tools-v1, S3-K2; plan #1664 S3-U4, S3-O1, S3-O2, S3-I2, S3-D1,
// S3-D2). The generator mixes tool requests of every class (valid, look-alike
// names, arguments outside the schema, addresses), answers of every size,
// provider errors, timeouts, revocations at any step and both an allowed and
// an empty starting set. Everything is invented.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  decodeDataParts,
  encodeDataParts,
  TOOL_STEP_MAX,
  type PortToolCall,
  type ToolName,
} from "../../server/domain/index.ts";
import {
  createSyntheticAssistant,
  type SyntheticBranch,
} from "../../server/external/assistant/index.ts";
import {
  createSearchGuard,
  runToolLoop,
  type BeginStep,
  type SearchTransport,
} from "../../server/external/assistant-tools/index.ts";
import { SYNTHETIC_TOOL_SAMPLES } from "../../test-support/assistant-tools/index.ts";

const INSTRUCTIONS = "Upute poslužitelja (izmišljeno).";

const call: fc.Arbitrary<PortToolCall> = fc.oneof(
  fc.string({ maxLength: 40 }).map((query) => ({ name: "web_search", args: { query } })),
  fc
    .constantFrom(...SYNTHETIC_TOOL_SAMPLES.lookAlikeNames)
    .map((name) => ({ name, args: { query: "x" } })),
  fc.constantFrom(...SYNTHETIC_TOOL_SAMPLES.badArgs).map((args) => ({ name: "web_search", args })),
  fc
    .constantFrom(...SYNTHETIC_TOOL_SAMPLES.addressQueries)
    .map((query) => ({ name: "web_search", args: { query } })),
);

const branch: fc.Arbitrary<SyntheticBranch> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .array(call, { minLength: 1, maxLength: 3 })
      .map((calls) => ({ branch: "tool_calls" as const, calls, actualMicro: 1n })),
  },
  {
    weight: 1,
    arbitrary: fc
      .string({ maxLength: 60 })
      .map((text) => ({ branch: "success" as const, actualMicro: 1n, text: `${text}.` })),
  },
  { weight: 1, arbitrary: fc.constant({ branch: "provider_error" as const, actualMicro: 1n }) },
  { weight: 1, arbitrary: fc.constant({ branch: "timeout" as const }) },
  { weight: 1, arbitrary: fc.constant({ branch: "oversized_response" as const, actualMicro: 1n }) },
  { weight: 1, arbitrary: fc.constant({ branch: "endless_tools" as const, actualMicro: 1n }) },
);

describe("tool loop properties (S3-K2)", () => {
  it("bounded, stable instructions, data round trip, nothing runs unless allowed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(branch, { minLength: TOOL_STEP_MAX + 2, maxLength: TOOL_STEP_MAX + 2 }),
        fc.boolean(),
        fc.option(fc.integer({ min: 0, max: TOOL_STEP_MAX }), { nil: undefined }),
        fc.string({ minLength: 1, maxLength: 80 }),
        async (script, withTools, revokeAt, paragraph) => {
          const port = createSyntheticAssistant(script);
          const outcomes: string[] = [];
          let allowed: readonly ToolName[] = withTools ? ["web_search"] : [];
          const beginStep: BeginStep = (step) => {
            if (step.stepNo !== outcomes.length + 1 || step.stepNo > TOOL_STEP_MAX || !withTools)
              return Promise.resolve({ status: "refused" });
            if (revokeAt !== undefined && outcomes.length >= revokeAt) allowed = [];
            const outcome =
              allowed.length === 0
                ? "denied_revoked"
                : step.toolName === null
                  ? "denied_not_in_set"
                  : !step.argsValid
                    ? "denied_schema"
                    : "allowed";
            outcomes.push(outcome);
            return Promise.resolve({
              status: "ok",
              outcome,
              tools: outcome === "denied_revoked" ? [] : allowed,
            });
          };
          let gets = 0;
          const transport: SearchTransport = {
            resolve: () => Promise.resolve(["93.184.216.34"]),
            get: () => {
              gets += 1;
              return Promise.resolve({
                status: 200,
                text: SYNTHETIC_TOOL_SAMPLES.forgedFence,
                overflow: false,
              });
            },
          };
          const result = await runToolLoop(
            {
              callPort: (input) => port.complete(input),
              beginStep,
              finishStep: () => Promise.resolve(true),
              guard: createSearchGuard({
                destinations: [
                  {
                    id: "trazilica-a",
                    endpoint: "https://trazilica-a.invalid/search",
                    queryParameter: "q",
                  },
                ],
                transport,
              }),
            },
            {
              instructions: INSTRUCTIONS,
              history: [],
              paragraph,
              purposeKey: "literature_search",
              modelId: "model-test-1",
              tools: withTools ? ["web_search"] : [],
            },
          );
          // 1. Bounded: at most TOOL_STEP_MAX steps and one more provider call.
          expect(outcomes.length).toBeLessThanOrEqual(TOOL_STEP_MAX);
          expect(port.calls.length).toBeLessThanOrEqual(TOOL_STEP_MAX + 1);
          // 2. The instructions never change and never carry the paragraph.
          for (const input of port.calls) expect(input.instructions).toBe(INSTRUCTIONS);
          // 3. Every call's data round-trips and starts with the one paragraph.
          for (const input of port.calls) {
            expect(decodeDataParts(encodeDataParts(input.data))).toEqual(input.data);
            expect(input.data.filter((part) => part.kind === "paragraph")).toEqual([
              { kind: "paragraph", text: paragraph, truncated: false },
            ]);
          }
          // 4. Without a loop no tool is offered and no step is taken (S3-D2).
          if (!withTools) {
            expect(outcomes).toEqual([]);
            for (const input of port.calls) expect(input.tools).toEqual([]);
          }
          // 5. Only an allowed step reaches the guard; a revocation ends the request.
          expect(gets).toBe(outcomes.filter((o) => o === "allowed").length);
          if (outcomes.includes("denied_revoked")) {
            expect(result.kind).toBe("request_revoked");
            expect(outcomes.at(-1)).toBe("denied_revoked");
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
