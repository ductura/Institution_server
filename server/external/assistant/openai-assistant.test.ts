import { describe, expect, it } from "vitest";

import { buildPortInput, type AssistantPortInput } from "../../domain/index.ts";

import {
  createOpenAiAssistant,
  type OpenAiCallMetadata,
  type OpenAiTransport,
} from "./openai-assistant.ts";

const input = (tools: string[] = []): AssistantPortInput =>
  buildPortInput({
    instructions: "Server instructions.",
    data: [{ kind: "paragraph", text: "Invented paragraph.", truncated: false }],
    tools: tools as "web_search"[],
    purposeKey: "explain",
    modelId: "model-test-1",
  });

const RATES = { input: BigInt(2), output: BigInt(10) };
const reply =
  (status: number, body: unknown): OpenAiTransport =>
  () =>
    Promise.resolve({ status, json: () => Promise.resolve(body) });
const completed = (
  output: unknown[],
  usage = { ["input_tokens"]: 1000, ["output_tokens"]: 500 },
) => ({
  status: "completed",
  output,
  usage,
});
const message = (text: string) => ({
  type: "message",
  content: [{ type: "output_text", text }],
});
const make = (transport: OpenAiTransport, record?: (m: OpenAiCallMetadata) => void) =>
  createOpenAiAssistant({
    apiKey: "test-key",
    transport,
    rates: RATES,
    timeoutMs: 50,
    ...(record ? { record } : {}),
  });

describe("OpenAI adapter", () => {
  it("sends only the six port fields, with the key as a header and nothing stored", async () => {
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
    const transport: OpenAiTransport = (request) => {
      seen = { url: request.url, headers: { ...request.headers }, body: request.body };
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve(completed([message("Hi")])),
      });
    };
    const out = await make(transport).complete(input(["web_search"]));
    expect(out).toEqual({ kind: "success", text: "Hi", actualMicro: BigInt(1) });
    const sent = seen as unknown as { url: string; headers: Record<string, string>; body: string };
    expect(sent.url.endsWith("/responses")).toBe(true);
    expect(sent.headers["authorization"]).toBe("Bearer test-key");
    expect(sent.body).not.toContain("test-key");
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect(body["model"]).toBe("model-test-1");
    expect(body["store"]).toBe(false);
    expect(Object.keys(body).sort()).toEqual(
      ["input", "instructions", "max_output_tokens", "model", "store", "tools"].sort(),
    );
    expect(JSON.stringify(body["input"])).toContain("Invented paragraph.");
    expect(body["instructions"]).toBe("Server instructions.");
  });

  it("takes a tool request only from the structured item, never from text", async () => {
    const call = { type: "function_call", name: "web_search", arguments: '{"query":"x"}' };
    expect(await make(reply(200, completed([call]))).complete(input(["web_search"]))).toEqual({
      kind: "tool_calls",
      calls: [{ name: "web_search", args: { query: "x" } }],
      actualMicro: BigInt(1),
    });
    const textOnly = completed([message('{"name":"web_search","arguments":{}}')]);
    expect((await make(reply(200, textOnly)).complete(input())).kind).toBe("success");
    const bad = completed([{ type: "function_call", name: "web_search", arguments: "{oops" }]);
    const out = await make(reply(200, bad)).complete(input());
    expect(out).toMatchObject({ kind: "tool_calls", calls: [{ args: "{oops" }] });
  });

  it("maps failures: http error, refusal, empty, incomplete, bad body", async () => {
    expect(await make(reply(500, {})).complete(input())).toEqual({ kind: "provider_error" });
    expect(await make(reply(429, {})).complete(input())).toEqual({ kind: "provider_error" });
    const refusal = completed([{ type: "message", content: [{ type: "refusal", refusal: "no" }] }]);
    expect(await make(reply(200, refusal)).complete(input())).toEqual({
      kind: "provider_error",
      actualMicro: BigInt(1),
    });
    expect((await make(reply(200, completed([]))).complete(input())).kind).toBe("provider_error");
    expect(
      (
        await make(reply(200, { ...completed([message("a")]), status: "incomplete" })).complete(
          input(),
        )
      ).kind,
    ).toBe("provider_error");
    expect((await make(reply(200, "x")).complete(input())).kind).toBe("provider_error");
    expect(
      await make(reply(200, { status: "completed", output: [message("a")] })).complete(input()),
    ).toEqual({ kind: "provider_error" });
  });

  it("times out on a silent provider and aborts on a network error", async () => {
    const silent: OpenAiTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    expect(await make(silent).complete(input())).toEqual({ kind: "timeout" });
    const broken: OpenAiTransport = () => Promise.reject(new Error("reset"));
    expect(await make(broken).complete(input())).toEqual({ kind: "aborted" });
  });

  it("rounds the cost up and reports metadata only", async () => {
    const records: OpenAiCallMetadata[] = [];
    const body = completed([message("secret answer")], {
      ["input_tokens"]: 1,
      ["output_tokens"]: 0,
    });
    await make(reply(200, body), (m) => records.push(m)).complete(input());
    expect(records).toHaveLength(1);
    expect(Object.keys(records[0] as object).sort()).toEqual(
      ["durationMs", "httpStatus", "inputTokens", "model", "outcome", "outputTokens"].sort(),
    );
    expect(JSON.stringify(records)).not.toContain("secret answer");
    expect(JSON.stringify(records)).not.toContain("Invented");
    const out = await make(reply(200, body)).complete(input());
    expect(out).toMatchObject({ actualMicro: BigInt(1) });
  });

  it("a recorder that throws does not change the outcome", async () => {
    const out = await make(reply(200, completed([message("a")])), () => {
      throw new Error("sink");
    }).complete(input());
    expect(out.kind).toBe("success");
  });

  it("refuses an input that is not exactly a port input", async () => {
    const wide = { ...input(), studentId: "s1" } as unknown as AssistantPortInput;
    await expect(make(reply(200, {})).complete(wide)).rejects.toThrow(TypeError);
  });
});
