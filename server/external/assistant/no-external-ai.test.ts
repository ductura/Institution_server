import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// SRV-1809 (plan M9.0-S2; acceptance 2): no code in this repo calls an
// external AI. There is no AI SDK among the dependencies, no import of one,
// no address of a provider's API, and the assistant code opens no network.
// The only adapter is the synthetic one; the real one waits for M9.1 (Q-10).

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SELF = relative(ROOT, fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".pnpm-store"]);
const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs|sql|json|ya?ml|sh)$/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE.test(entry.name)) out.push(relative(ROOT, path));
  }
  return out;
}

/** Package names of AI provider SDKs and frameworks that wrap them. */
const AI_PACKAGE =
  /^(?:openai|@openai\/.+|@anthropic-ai\/.+|@google\/(?:generative-ai|genai)|@google-cloud\/(?:vertexai|aiplatform)|@mistralai\/.+|cohere-ai|ollama|groq-sdk|@huggingface\/.+|langchain|@langchain\/.+|ai|@ai-sdk\/.+|@aws-sdk\/client-bedrock.*|replicate|together-ai|@azure\/openai|llamaindex)$/u;

/** API hosts of AI providers, and the default local port of a model server. */
const AI_HOST =
  /\b(?:api\.openai\.com|[a-z0-9-]+\.openai\.azure\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|[a-z0-9-]*aiplatform\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(?:ai|com)|api\.deepseek\.com|api\.groq\.com|api-inference\.huggingface\.co|bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com|api\.together\.xyz|api\.perplexity\.ai|api\.replicate\.com|(?:localhost|127\.0\.0\.1):11434)\b/iu;

const files = walk(ROOT).filter((file) => file !== SELF);

// F4-PM2-R11 (D-316): the one file that may name the provider's API host is
// the OpenAI adapter; it opens no connection itself (the transport is handed in).
const HOST_ALLOWED = ["server/external/assistant/openai-assistant.ts"];

describe("no external AI in this repo (acceptance 2)", () => {
  it("scans the repo", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("server/external/assistant/synthetic-assistant.ts");
  });

  it("no package.json depends on an AI SDK", () => {
    const found: string[] = [];
    for (const file of files.filter((f) => f.endsWith("package.json"))) {
      const json = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as Record<string, unknown>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const deps = json[field];
        if (deps && typeof deps === "object") {
          for (const name of Object.keys(deps))
            if (AI_PACKAGE.test(name)) found.push(`${file}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("the lockfile resolves no AI SDK", () => {
    const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
    const names = new Set(
      [...lock.matchAll(/^ {2}'?(@?[^@\s'/]+(?:\/[^@\s']+)?)@[^:\s]+'?:\s*$/gmu)].map((m) => m[1]),
    );
    expect(names.size).toBeGreaterThan(50);
    expect([...names].filter((name) => name !== undefined && AI_PACKAGE.test(name))).toEqual([]);
  });

  it("no source file imports an AI SDK", () => {
    const found: string[] = [];
    for (const file of files.filter((f) => /\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(f))) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const ref of ts.preProcessFile(text, true, true).importedFiles) {
        if (AI_PACKAGE.test(ref.fileName)) found.push(`${file}: ${ref.fileName}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("no file names the API host of an AI provider", () => {
    const found = files.filter((file) => AI_HOST.test(readFileSync(join(ROOT, file), "utf8")));
    expect(found).toEqual(HOST_ALLOWED);
  });

  it("the patterns do catch what they are for", () => {
    for (const name of [
      "openai",
      "@anthropic-ai/sdk",
      "@google/genai",
      "@mistralai/mistralai",
      "ai",
    ]) {
      expect(AI_PACKAGE.test(name)).toBe(true);
    }
    for (const name of ["aid", "@sinclair/typebox", "typescript", "pg"]) {
      expect(AI_PACKAGE.test(name)).toBe(false);
    }
    expect(AI_HOST.test("https://api.openai.com/v1/chat")).toBe(true);
    expect(AI_HOST.test("http://localhost:11434/api")).toBe(true);
    expect(AI_HOST.test("https://example.invalid/api")).toBe(false);
  });
});

describe("the assistant code opens no network and reads no secret (S1, M9)", () => {
  const AREAS = [
    "server/external/assistant/",
    "server/domain/assistant/",
    "server/contracts/evidence-transfer/",
  ];
  const code = files.filter(
    (file) => AREAS.some((area) => file.startsWith(area)) && /(?<!\.test)\.ts$/u.test(file),
  );

  it("covers the areas", () => {
    for (const area of AREAS) expect(code.some((file) => file.startsWith(area))).toBe(true);
  });

  it.each(code.map((file) => [file]))("%s", (file) => {
    const text = readFileSync(join(ROOT, file), "utf8");
    const imports = ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName);
    expect(imports.filter((name) => !name.startsWith(".") && name !== "@sinclair/typebox")).toEqual(
      [],
    );
    expect(text).not.toMatch(/process\.env|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/u);
  });

  it("the synthetic and the OpenAI adapter are the only adapters", () => {
    const adapterFiles = readdirSync(join(ROOT, "server/external/assistant"))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .sort();
    // A new file here is a new adapter or a new rule; it needs this list, and a review.
    expect(adapterFiles).toEqual([
      "index.ts",
      "institution-setting.ts",
      "openai-assistant.ts",
      "provider-port.ts",
      "synthetic-assistant.ts",
    ]);
    const exported = readFileSync(join(ROOT, "server/external/assistant/index.ts"), "utf8");
    expect(exported.match(/\bcreate[A-Z]\w*Assistant\b/gu)).toEqual([
      "createSyntheticAssistant",
      "createOpenAiAssistant",
    ]);
  });
});
