import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  AI_TRANSFER_KEYS_V1,
  AI_TRANSFER_SCHEMA_V1,
  AiTransferRecordV1,
  canonicalAiTransferRecordV1,
  checkAiTransferAllowedV1,
  MAX_AI_TRANSFER_CATALOG_VERSION,
  parseAiTransferRecordV1,
  parseAiTransferRecordV1Text,
} from "./ai-transfer.ts";

// SRV-1809 (plan M9.0-S1; Ductus docs/contracts/evidence-segment-v4.md,
// "ductus-ai-transfer-v1", tests "Zapis prijenosa" C1 to C5 and C11). The
// golden vectors were generated outside the code under test (A8). All data is
// invented: provider-test-a, model-test-1, Lorem text.

type Vector = {
  name: string;
  record: Record<string, unknown>;
  canonical: string;
  sha256: string;
};
const vectors = JSON.parse(
  readFileSync(new URL("./golden-vectors/ai-transfer-v1.json", import.meta.url), "utf8"),
) as { aiTransferValid: Vector[] };
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const first = vectors.aiTransferValid[0]!;
const valid = (): Record<string, unknown> => ({ ...first.record });

describe("ai transfer v1: golden vectors (A8, K12)", () => {
  it.each(vectors.aiTransferValid.map((v) => [v.name, v] as const))("%s", (_name, vector) => {
    const parsed = parseAiTransferRecordV1(vector.record);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(canonicalAiTransferRecordV1(parsed.record)).toBe(vector.canonical);
    expect(sha256(canonicalAiTransferRecordV1(parsed.record))).toBe(vector.sha256);
    expect(parseAiTransferRecordV1Text(vector.canonical)).toEqual(parsed);
    expect(Value.Check(AiTransferRecordV1, vector.record)).toBe(true);
  });

  it("returns a frozen copy in key order, never the input", () => {
    const input = valid();
    const parsed = parseAiTransferRecordV1(input);
    if (!parsed.ok) throw new Error("vector must parse");
    expect(parsed.record).not.toBe(input);
    expect(Object.isFrozen(parsed.record)).toBe(true);
    expect(Object.keys(parsed.record)).toEqual([...AI_TRANSFER_KEYS_V1]);
  });
});

describe("ai transfer v1: closed format (C1, C2, K5, K11)", () => {
  it.each(AI_TRANSFER_KEYS_V1.map((key) => [key]))("refuses a record without %s", (key) => {
    const record = valid();
    delete record[key];
    expect(parseAiTransferRecordV1(record)).toEqual({ ok: false, code: "TRANSFER_INVALID" });
    expect(Value.Check(AiTransferRecordV1, record)).toBe(false);
  });

  // C11: content of the conversation, instructions, the text and any identity
  // are not in the record; each is an unknown key.
  it.each([
    ["text", "Lorem odlomak 1"],
    ["instructions", "Upute (izmišljeno)."],
    ["messages", []],
    ["paragraph", "Lorem"],
    ["userId", "00000000-0000-4000-8000-0000000000e1"],
    ["studentEmail", "lorem@student.invalid"],
    ["costMicro", "1"],
  ])("refuses the content or identity key %s (C11)", (key, value) => {
    expect(parseAiTransferRecordV1({ ...valid(), [key]: value }).ok).toBe(false);
    expect(Value.Check(AiTransferRecordV1, { ...valid(), [key]: value })).toBe(false);
  });

  it.each([
    ["transferSchema", "ductus-ai-transfer-v2"],
    ["transferSchema", "Ductus-ai-transfer-v1"],
    ["transferId", "00000000-0000-0000-0000-000000000000"],
    ["transferId", "00000000-0000-4000-8000-0000000000A1"],
    ["conversationId", "not-a-uuid"],
    ["responseId", 7],
    ["documentId", ""],
    ["documentId", "   "],
    ["documentId", "x".repeat(257)],
    ["documentId", "a\uD800b"],
    ["providerId", "Provider-Test-A"],
    ["providerId", "-provider"],
    ["providerId", "p".repeat(65)],
    ["modelId", "model test"],
    ["modelId", "m".repeat(129)],
    ["purposeCatalogVersion", 0],
    ["purposeCatalogVersion", MAX_AI_TRANSFER_CATALOG_VERSION + 1],
    ["purposeCatalogVersion", 1.5],
    ["purposeCatalogVersion", "2"],
    ["purposeId", "Proofreading"],
    ["phaseId", ""],
    ["textSha256", "E".repeat(64)],
    ["textSha256", "e".repeat(63)],
    ["transferredAt", "2026-11-02T10:40:30.000Z"],
    ["transferredAt", "2026-11-02T10:40:00Z"],
    ["transferredAt", "2026-02-30T10:40:00.000Z"],
    ["transferredAt", "2026-11-02T10:40:00.000+01:00"],
  ])("refuses %s = %j", (key, value) => {
    expect(parseAiTransferRecordV1({ ...valid(), [key]: value })).toEqual({
      ok: false,
      code: "TRANSFER_INVALID",
    });
  });

  it("holds every bound at its value (K9)", () => {
    const longest = {
      ...valid(),
      documentId: "d".repeat(256),
      providerId: `p${"-".repeat(63)}`,
      modelId: `m${".".repeat(127)}`,
      purposeCatalogVersion: MAX_AI_TRANSFER_CATALOG_VERSION,
      purposeId: `a${"_".repeat(63)}`,
    };
    expect(parseAiTransferRecordV1(longest).ok).toBe(true);
    expect(Value.Check(AiTransferRecordV1, longest)).toBe(true);
  });

  it("refuses arrays, class instances, symbol keys and inherited keys", () => {
    expect(parseAiTransferRecordV1([valid()]).ok).toBe(false);
    expect(parseAiTransferRecordV1(null).ok).toBe(false);
    expect(parseAiTransferRecordV1(Object.assign(new (class {})(), valid())).ok).toBe(false);
    expect(parseAiTransferRecordV1({ ...valid(), [Symbol("x")]: 1 }).ok).toBe(false);
    const inherited = Object.create(valid()) as Record<string, unknown>;
    expect(parseAiTransferRecordV1(inherited).ok).toBe(false);
  });

  it("names exactly one format", () => {
    expect(AI_TRANSFER_SCHEMA_V1).toBe("ductus-ai-transfer-v1");
  });
});

describe("ai transfer v1: canonical text only (K13, B-8)", () => {
  it.each([
    ["whitespace", (t: string) => t.replace(":", ": ")],
    ["key order", () => JSON.stringify(first.record)],
    ["duplicate key", (t: string) => t.replace("{", `{"phaseId":"drafting",`)],
    [
      "number spelling",
      (t: string) => t.replace('"purposeCatalogVersion":2', '"purposeCatalogVersion":2.0'),
    ],
    ["escaped character", (t: string) => t.replace("doc-lorem-1", "doc-lorem\\u002d1")],
  ])("refuses another spelling: %s", (_name, mutate) => {
    const text = mutate(first.canonical);
    expect(text).not.toBe(first.canonical);
    expect(parseAiTransferRecordV1Text(text).ok).toBe(false);
  });

  it("refuses text that is not JSON", () => {
    expect(parseAiTransferRecordV1Text("{")).toEqual({ ok: false, code: "TRANSFER_INVALID" });
  });
});

describe("ai transfer v1: allowed provider, model and purpose (C3, C4)", () => {
  const parsed = parseAiTransferRecordV1(valid());
  if (!parsed.ok) throw new Error("vector must parse");
  const record = parsed.record;
  const allowed = {
    models: [{ providerId: "provider-test-a", modelId: "model-test-1" }],
    purposeCatalogVersion: 2,
    purposeIds: ["proofreading", "formatting"],
  };

  it("passes an allowed pair and purpose", () => {
    expect(checkAiTransferAllowedV1(record, allowed)).toEqual({ ok: true, record });
  });

  it("refuses a provider or model outside the pair, and an empty list", () => {
    for (const models of [
      [],
      [{ providerId: "provider-test-a", modelId: "model-test-2" }],
      [{ providerId: "provider-test-b", modelId: "model-test-1" }],
    ]) {
      expect(checkAiTransferAllowedV1(record, { ...allowed, models })).toEqual({
        ok: false,
        code: "PROVIDER_NOT_ALLOWED",
      });
    }
  });

  it("refuses a purpose outside the assignment or another catalogue version", () => {
    expect(checkAiTransferAllowedV1(record, { ...allowed, purposeIds: ["formatting"] })).toEqual({
      ok: false,
      code: "PURPOSE_NOT_ALLOWED",
    });
    expect(checkAiTransferAllowedV1(record, { ...allowed, purposeCatalogVersion: 1 })).toEqual({
      ok: false,
      code: "PURPOSE_NOT_ALLOWED",
    });
  });
});
