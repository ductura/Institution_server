// Unit tests of declaration v1 (contract ductura/Institution_server#499,
// sections 1 to 4, 7.1 and 9). Every name, form and text is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../forensics/index.ts";

import * as declaration from "./index.ts";
import {
  MAX_ATTACHED_CONVERSATIONS,
  MAX_DECLARED_TEXT_CODE_POINTS,
  MAX_DECLARED_TOOLS,
  MAX_EXTERNAL_ATTACHMENT_BYTES,
  MAX_EXTERNAL_ATTACHMENTS,
  MAX_EXTERNAL_TOTAL_BYTES,
  MAX_HUMAN_HELP_ENTRIES,
  MAX_TOOL_FIELD_CODE_POINTS,
  attachmentListProblem,
  checkExternalAttachmentBytes,
  computeMessagesSha256,
  declarationSha256,
  incompleteFields,
  isDeclarationPayloadV1,
  isDeclaredText,
  isToolFieldText,
  parseDeclarationFormFile,
  parseDeclarationPayloadV1Bytes,
  parseDeclarationPutBody,
  resolveAttachmentReason,
  sortAttachments,
  type DeclarationAttachment,
  type DeclarationPayloadV1,
  type DeclarationPutBody,
} from "./index.ts";
import { sha256Hex } from "./attachments.ts";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Section 9, byte for byte.
const VECTOR_JCS =
  '{"ai":{"attachments":[{"conversationId":"1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b","messagesSha256":"4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5","reason":"transferred","throughSeq":2},{"byteLength":47,"contentSha256":"a2851d45f6fc65bb4dc7832a57ea004c345ceab128d1576f61c116969282de90","externalAttachmentId":"6e5d4c3b-2a19-4f8e-9d7c-6b5a4f3e2d1c","format":"text/plain","reason":"external_upload"}],"declaredTools":[{"phaseText":"Završna dorada","purposeText":"Lektura uvoda","toolLabel":"Izmišljeni vanjski alat"}],"recorded":[{"aiTransferId":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","aiTransferSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}],"use":"used"},"assignmentId":"3b7e2f4a-9c1d-4e8b-a5f6-0d2c4b6a8e91","assignmentVersion":1,"confirmedAt":"2026-11-02T10:40:00.123456Z","declarationId":"5d0c6a3e-8f21-4b7a-9c45-1e2f3a4b5c6d","declarationSchema":"ductura-declaration-v1","declarationVersion":1,"documentId":"doc-1","form":{"formId":"fpzg-izjava","formSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","formVersion":1},"humanHelp":{"entries":[{"kind":"language","text":"Izmišljena kolegica pročitala je uvod i predložila kraću rečenicu."}],"received":true},"ownWork":{"confirmed":true},"principalId":"72cd1705-85fc-4754-a382-c2500d038368","revision":7}';
const VECTOR_SHA256 = "f89129ae57b4451a03b41615f3dd1f35a6b7de2841a17535f2ce525c95870638";

const vector = (): DeclarationPayloadV1 => JSON.parse(VECTOR_JCS) as DeclarationPayloadV1;
const valid = (mutate: (p: DeclarationPayloadV1) => void): boolean => {
  const p = vector();
  mutate(p);
  return isDeclarationPayloadV1(p);
};

const uuid4 = (n: number): string =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const tool = { toolLabel: "Izmišljeni alat", purposeText: "Lektura", phaseText: "Dorada" };
const entry = { kind: "language", text: "Izmišljena pomoć." } as const;
const conversation = (n: number, reason: string): DeclarationAttachment =>
  ({
    reason,
    conversationId: uuid4(n),
    throughSeq: 1,
    messagesSha256: "a".repeat(64),
  }) as DeclarationAttachment;
const external = (n: number, byteLength = 1): DeclarationAttachment => ({
  reason: "external_upload",
  externalAttachmentId: uuid4(n),
  format: "text/plain",
  byteLength,
  contentSha256: "b".repeat(64),
});

describe("section 9 vector", () => {
  it("hashes the messages, the external bytes and the payload", () => {
    const m1 = sha256Hex("Primjer izmišljenog odlomka za lekturu.");
    const m2 = sha256Hex("Izmišljeni odgovor pomoćnika s ispravljenim zarezom.");
    expect(m1).toBe("bf39b3419f7625264a0560cf599f9ba46114cd3bde0fc96c0d2f2e1e48d557c6");
    expect(m2).toBe("68d50dc2602b63df1f11c57b24a8fc19f4971fc8b9092495d55ff7d563633e3b");
    expect(computeMessagesSha256([m1, m2])).toBe(
      "4e3b9c6ac3fb78cb2d24ca5d69d6206f4a23e4f03c2f7561ad2dd40dc549dbc5",
    );
    expect(computeMessagesSha256([m2, m1])).not.toBe(computeMessagesSha256([m1, m2]));
    expect(computeMessagesSha256([])).toBeNull();
    expect(computeMessagesSha256(["A".repeat(64)])).toBeNull();

    const file = checkExternalAttachmentBytes(
      "text/plain",
      utf8("Izmišljeni ispis razgovora iz vanjskog alata.\n"),
    );
    expect(file).toEqual({
      ok: true,
      format: "text/plain",
      byteLength: 47,
      contentSha256: "a2851d45f6fc65bb4dc7832a57ea004c345ceab128d1576f61c116969282de90",
    });

    const p = parseDeclarationPayloadV1Bytes(utf8(VECTOR_JCS));
    expect(p).not.toBeNull();
    expect(utf8(VECTOR_JCS).length).toBe(1333);
    expect(canonicalizeJcs(p)).toBe(VECTOR_JCS);
    expect(declarationSha256(p as DeclarationPayloadV1)).toBe(VECTOR_SHA256);
  });

  it("rejects non-canonical bytes, a duplicate key and an unknown key at every level", () => {
    expect(parseDeclarationPayloadV1Bytes(utf8(`${VECTOR_JCS}\n`))).toBeNull();
    expect(parseDeclarationPayloadV1Bytes(utf8(JSON.stringify(vector(), null, 1)))).toBeNull();
    expect(parseDeclarationPayloadV1Bytes(utf8(`{"ai":{},${VECTOR_JCS.slice(1)}`))).toBeNull();
    expect(parseDeclarationPayloadV1Bytes(new Uint8Array([0xff, 0xfe]))).toBeNull();

    const levels: ((p: DeclarationPayloadV1) => Record<string, unknown>)[] = [
      (p) => p,
      (p) => p.form,
      (p) => p.ownWork,
      (p) => p.humanHelp,
      (p) => p.humanHelp.entries[0] as Record<string, unknown>,
      (p) => p.ai,
      (p) => p.ai.recorded[0] as Record<string, unknown>,
      (p) => p.ai.declaredTools[0] as Record<string, unknown>,
      (p) => p.ai.attachments[0] as Record<string, unknown>,
      (p) => p.ai.attachments[1] as Record<string, unknown>,
    ];
    for (const level of levels) {
      expect(valid((p) => void (level(p)["zz"] = 1))).toBe(false);
    }
    expect(() => declarationSha256({ ...vector(), revision: 0 })).toThrow(TypeError);
  });

  it("holds the payload rules of section 1", () => {
    expect(valid(() => {})).toBe(true);
    expect(valid((p) => void (p.ownWork = { confirmed: false as true }))).toBe(false);
    expect(valid((p) => void (p.humanHelp.received = false))).toBe(false);
    expect(valid((p) => void (p.humanHelp = { received: false, entries: [] }))).toBe(true);
    expect(valid((p) => void (p.ai.use = "not_used"))).toBe(false);
    expect(
      valid((p) => {
        p.ai.use = "not_used";
        p.ai.declaredTools = [];
      }),
    ).toBe(true);
    expect(valid((p) => void (p.declarationId = "5d0c6a3e-8f21-1b7a-9c45-1e2f3a4b5c6d"))).toBe(
      false,
    );
    expect(valid((p) => void (p.confirmedAt = "2026-11-02T10:40:00Z"))).toBe(false);
    expect(
      valid((p) => {
        const r = p.ai.recorded[0]!;
        p.ai.recorded = [r, { ...r }];
      }),
    ).toBe(false);
    expect(valid((p) => void p.ai.attachments.reverse())).toBe(false);
  });
});

describe("section 4 limits", () => {
  it("passes at each limit and fails one over", () => {
    const entries = (n: number) => (p: DeclarationPayloadV1) =>
      void (p.humanHelp.entries = Array.from({ length: n }, () => ({ ...entry })));
    expect(valid(entries(MAX_HUMAN_HELP_ENTRIES))).toBe(true);
    expect(valid(entries(MAX_HUMAN_HELP_ENTRIES + 1))).toBe(false);

    const tools = (n: number) => (p: DeclarationPayloadV1) =>
      void (p.ai.declaredTools = Array.from({ length: n }, () => ({ ...tool })));
    expect(valid(tools(MAX_DECLARED_TOOLS))).toBe(true);
    expect(valid(tools(MAX_DECLARED_TOOLS + 1))).toBe(false);

    // "ž" is one code point but two UTF-16 units; "😀" is one code point and a pair.
    expect(isDeclaredText("ž".repeat(MAX_DECLARED_TEXT_CODE_POINTS))).toBe(true);
    expect(isDeclaredText("😀".repeat(MAX_DECLARED_TEXT_CODE_POINTS))).toBe(true);
    expect(isDeclaredText("ž".repeat(MAX_DECLARED_TEXT_CODE_POINTS + 1))).toBe(false);
    expect(isToolFieldText("😀".repeat(MAX_TOOL_FIELD_CODE_POINTS))).toBe(true);
    expect(isToolFieldText("a".repeat(MAX_TOOL_FIELD_CODE_POINTS + 1))).toBe(false);

    const many = (n: number) => Array.from({ length: n }, (_, i) => external(i + 1));
    expect(attachmentListProblem(many(MAX_EXTERNAL_ATTACHMENTS))).toBeNull();
    expect(attachmentListProblem(many(MAX_EXTERNAL_ATTACHMENTS + 1))).toBe("external_count");
    const half = MAX_EXTERNAL_TOTAL_BYTES / 5;
    expect(attachmentListProblem([1, 2, 3, 4, 5].map((n) => external(n, half)))).toBeNull();
    expect(
      attachmentListProblem([1, 2, 3, 4, 5, 6].map((n) => external(n, n === 6 ? 1 : half))),
    ).toBe("external_bytes");

    const added = (n: number) =>
      Array.from({ length: n }, (_, i) => conversation(i + 1, "student_added"));
    expect(attachmentListProblem(added(MAX_ATTACHED_CONVERSATIONS))).toBeNull();
    expect(attachmentListProblem(added(MAX_ATTACHED_CONVERSATIONS + 1))).toBe(
      "student_added_count",
    );
    const mandatory = Array.from({ length: 3 * MAX_ATTACHED_CONVERSATIONS }, (_, i) =>
      conversation(i + 1, "transferred"),
    );
    expect(attachmentListProblem(mandatory)).toBeNull();
    expect(valid((p) => void (p.ai.attachments = mandatory))).toBe(true);

    const big = new Uint8Array(MAX_EXTERNAL_ATTACHMENT_BYTES).fill(0x61);
    expect(checkExternalAttachmentBytes("text/plain", big).ok).toBe(true);
    const over = new Uint8Array(MAX_EXTERNAL_ATTACHMENT_BYTES + 1).fill(0x61);
    expect(checkExternalAttachmentBytes("text/plain", over)).toEqual({
      ok: false,
      reason: "invalid_input",
    });

    expect(valid((p) => void (p.documentId = "d".repeat(256)))).toBe(true);
    expect(valid((p) => void (p.documentId = "d".repeat(257)))).toBe(false);
  });
});

describe("section 1.6 declared text", () => {
  it.each([
    ["not NFC", "Izmišljeno"],
    ["empty", ""],
    ["only spaces", "   "],
    ["edge space", " Izmišljeno"],
    ["BOM", "﻿Izmišljeno"],
    ["lone surrogate", "Izmi\uD800šljeno"],
    ["C0", "Izmi\u0007šljeno"],
    ["C1", "Izmi\u0085šljeno"],
    ["CR", "Izmi\ršljeno"],
    ["bidi override", "Izmi‮šljeno"],
    ["bidi isolate", "Izmi⁧šljeno"],
  ])("rejects %s", (_, text) => {
    expect(isDeclaredText(text)).toBe(false);
    expect(isToolFieldText(text)).toBe(false);
  });

  it("allows a newline only in multiline text", () => {
    expect(isDeclaredText("Prvi red.\nDrugi red.")).toBe(true);
    expect(isToolFieldText("Prvi red.\nDrugi red.")).toBe(false);
    expect(isDeclaredText("Izmišljeno 😀")).toBe(true);
    expect(isDeclaredText(42)).toBe(false);
  });
});

describe("section 3 external attachment", () => {
  const bad = { ok: false, reason: "invalid_input" };
  it("accepts every format in the list and nothing else", () => {
    expect(checkExternalAttachmentBytes("text/plain", utf8("Izmišljeno.\n")).ok).toBe(true);
    expect(checkExternalAttachmentBytes("application/pdf", utf8("%PDF-1.7\n")).ok).toBe(true);
    for (const f of ["text/html", "TEXT/PLAIN", "text/plain; charset=utf-8", "image/png", ""]) {
      expect(checkExternalAttachmentBytes(f, utf8("x"))).toEqual({
        ok: false,
        reason: "unsupported_media_type",
      });
    }
  });

  it("rejects bad bytes", () => {
    expect(checkExternalAttachmentBytes("text/plain", new Uint8Array())).toEqual(bad);
    expect(checkExternalAttachmentBytes("application/pdf", new Uint8Array())).toEqual(bad);
    expect(checkExternalAttachmentBytes("text/plain", new Uint8Array([0xc3, 0x28]))).toEqual(bad);
    expect(checkExternalAttachmentBytes("text/plain", utf8("﻿x"))).toEqual(bad);
    expect(checkExternalAttachmentBytes("text/plain", utf8("a\r\nb"))).toEqual(bad);
    expect(checkExternalAttachmentBytes("text/plain", utf8("a\u0000b"))).toEqual(bad);
    expect(checkExternalAttachmentBytes("text/plain", utf8("a\tb\n")).ok).toBe(true);
    expect(checkExternalAttachmentBytes("application/pdf", utf8("PDF-1.7"))).toEqual(bad);
    expect(checkExternalAttachmentBytes("application/pdf", utf8("%PDF"))).toEqual(bad);
  });
});

describe("section 2.2 reasons", () => {
  const revisionText = "Uvod rada. Preneseni odlomak ostaje u tekstu.";
  it("follows the table for three conversations", () => {
    const first = resolveAttachmentReason({
      events: [{ kind: "transfer", text: "Preneseni odlomak" }],
      revisionText,
      studentSelected: false,
    });
    const second = resolveAttachmentReason({
      events: [
        { kind: "paste", verdict: "known", originKind: "ai-response", text: "Obrisani odlomak" },
      ],
      revisionText,
      studentSelected: false,
    });
    const third = resolveAttachmentReason({ events: [], revisionText, studentSelected: false });
    expect([first, second, third]).toEqual(["transferred", "transferred_deleted", null]);
  });

  it("covers the remaining rows", () => {
    const paste = (verdict: "known" | "not_observed", originKind = "ai-response") =>
      ({ kind: "paste", verdict, originKind, text: "Uvod rada." }) as const;
    const r = (events: Parameters<typeof resolveAttachmentReason>[0]["events"], sel = false) =>
      resolveAttachmentReason({ events, revisionText, studentSelected: sel });
    expect(r([paste("known")])).toBe("pasted_known");
    expect(r([paste("not_observed")])).toBeNull();
    expect(r([paste("not_observed")], true)).toBe("student_added");
    expect(r([paste("known", "user-message")])).toBeNull();
    expect(r([paste("known"), { kind: "transfer", text: "nema ga" }])).toBe("transferred");
    expect(r([{ kind: "transfer", text: "nema ga" }], true)).toBe("transferred_deleted");
    expect(declaration.isMandatoryReason("transferred_deleted")).toBe(true);
    expect(declaration.isMandatoryReason("student_added")).toBe(false);
  });

  it("sorts attachments by reason, then by id", () => {
    const list = [
      external(1),
      conversation(3, "student_added"),
      conversation(2, "transferred"),
      conversation(1, "transferred"),
    ];
    const sorted = sortAttachments(list);
    expect(sorted.map((a) => a.reason)).toEqual([
      "transferred",
      "transferred",
      "student_added",
      "external_upload",
    ]);
    expect(attachmentListProblem(sorted)).toBeNull();
    expect(attachmentListProblem([sorted[0]!, sorted[0]!])).toBe("order");
    const twoReasons = [conversation(1, "transferred"), conversation(1, "student_added")];
    expect(attachmentListProblem(twoReasons)).toBe("order");
    expect(valid((p) => void (p.ai.attachments = twoReasons))).toBe(false);
  });
});

describe("section 7.1 put body", () => {
  const body = (): DeclarationPutBody => ({
    baseVersion: 0,
    revision: 7,
    form: { formId: "test-izjava", formVersion: 1, formSha256: "c".repeat(64) },
    ownWork: { confirmed: true },
    humanHelp: { received: false, entries: [] },
    ai: { use: "not_used", declaredTools: [], attachments: [], externalAttachmentIds: [] },
    confirm: true,
  });

  it("parses a valid body and lists what blocks confirmation", () => {
    const parsed = parseDeclarationPutBody(body());
    expect(parsed.ok).toBe(true);
    expect(incompleteFields(body())).toEqual([]);
    const draft: DeclarationPutBody = {
      ...body(),
      ownWork: { confirmed: false },
      humanHelp: { received: true, entries: [] },
      ai: { ...body().ai, use: null },
      confirm: false,
    };
    expect(parseDeclarationPutBody(draft).ok).toBe(true);
    expect(incompleteFields(draft)).toEqual(["ownWork", "ai.use", "humanHelp"]);
    const tools = { ...body(), ai: { ...body().ai, declaredTools: [tool] } };
    expect(incompleteFields(tools)).toEqual(["ai.declaredTools"]);
  });

  it("rejects repeated ids, too many external ids and bad draft text", () => {
    const ref = { conversationId: uuid4(1), throughSeq: 1, messagesSha256: "a".repeat(64) };
    const withAi = (ai: Partial<DeclarationPutBody["ai"]>) =>
      parseDeclarationPutBody({ ...body(), ai: { ...body().ai, ...ai } }).ok;
    expect(withAi({ attachments: [ref] })).toBe(true);
    expect(withAi({ attachments: [ref, { ...ref }] })).toBe(false);
    expect(withAi({ externalAttachmentIds: [uuid4(1), uuid4(1)] })).toBe(false);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid4(i + 1));
    expect(withAi({ externalAttachmentIds: ids(MAX_EXTERNAL_ATTACHMENTS) })).toBe(true);
    expect(withAi({ externalAttachmentIds: ids(MAX_EXTERNAL_ATTACHMENTS + 1) })).toBe(false);
    expect(withAi({ declaredTools: [{ ...tool, toolLabel: " " }] })).toBe(false);
    expect(parseDeclarationPutBody({ ...body(), baseVersion: -1 }).ok).toBe(false);
    expect(parseDeclarationPutBody(null).ok).toBe(false);
  });
});

describe("form file", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./testdata/test-izjava.v1.json", import.meta.url)),
  );

  it("reads the fixture and hashes its JCS without the newline", () => {
    const parsed = parseDeclarationFormFile(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.form.formId).toBe("test-izjava");
    expect(parsed.form.formVersion).toBe(1);
    const jcs = bytes.subarray(0, -1);
    expect(parsed.form.formSha256).toBe(sha256Hex(jcs));
    expect(parseDeclarationFormFile(jcs)).toEqual(parsed);
  });

  it("rejects anything else", () => {
    const text = new TextDecoder().decode(bytes);
    const bad = (s: string) => parseDeclarationFormFile(utf8(s)).ok;
    expect(bad(`${text}\n`)).toBe(false);
    expect(bad(JSON.stringify(JSON.parse(text), null, 2))).toBe(false);
    expect(bad(text.replace('{"formId"', '{"extra":1,"formId"'))).toBe(false);
    expect(bad(text.replace('"formVersion":1', '"formVersion":0'))).toBe(false);
    expect(bad(text.replace("ductura-declaration-form-v1", "ductura-declaration-form-v2"))).toBe(
      false,
    );
  });
});
