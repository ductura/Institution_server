// Section 7.1 of contract #499: a put body with any key outside the closed
// set, or with a server-only key, never parses, so it never reaches the RPC.
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";

import { parseDeclarationPutBody, type DeclarationPutBody } from "./index.ts";

const body = (): DeclarationPutBody => ({
  baseVersion: 3,
  revision: 7,
  form: { formId: "test-izjava", formVersion: 1, formSha256: "c".repeat(64) },
  ownWork: { confirmed: true },
  humanHelp: { received: true, entries: [{ kind: "language", text: "Izmišljena pomoć." }] },
  ai: {
    use: "used",
    declaredTools: [{ toolLabel: "Izmišljeni alat", purposeText: "Lektura", phaseText: "Dorada" }],
    attachments: [
      {
        conversationId: "1f2e3d4c-5b6a-4987-8a6b-5c4d3e2f1a0b",
        throughSeq: 2,
        messagesSha256: "a".repeat(64),
      },
    ],
    externalAttachmentIds: ["6e5d4c3b-2a19-4f8e-9d7c-6b5a4f3e2d1c"],
  },
  confirm: false,
});

type Obj = Record<string, unknown>;
// Every object inside the body, by a path from the root.
const LEVELS: ((b: Obj) => Obj)[] = [
  (b) => b,
  (b) => b["form"] as Obj,
  (b) => b["ownWork"] as Obj,
  (b) => b["humanHelp"] as Obj,
  (b) => ((b["humanHelp"] as Obj)["entries"] as Obj[])[0]!,
  (b) => b["ai"] as Obj,
  (b) => ((b["ai"] as Obj)["declaredTools"] as Obj[])[0]!,
  (b) => ((b["ai"] as Obj)["attachments"] as Obj[])[0]!,
];
const SERVER_ONLY = ["reason", "recorded", "principalId", "confirmedAt"];

test("the base body parses", () => {
  expect(parseDeclarationPutBody(body()).ok).toBe(true);
});

test.prop([
  fc.integer({ min: 0, max: LEVELS.length - 1 }),
  fc.oneof(fc.string(), fc.constantFrom(...SERVER_ONLY)),
  fc.jsonValue(),
])("an extra key at any level gives invalid_input", (level, key, value) => {
  const b = structuredClone(body()) as unknown as Obj;
  const target = LEVELS[level]!(b);
  fc.pre(!Object.hasOwn(target, key));
  // An own key, as JSON.parse makes it: plain assignment of "__proto__" would
  // set the prototype instead and leave the body without an extra key.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  expect(parseDeclarationPutBody(b)).toEqual({ ok: false, reason: "invalid_input" });
});

test.each(LEVELS.map((_, level) => level))(
  'an own "__proto__" key from JSON.parse at level %i gives invalid_input',
  (level) => {
    const b = structuredClone(body()) as unknown as Obj;
    const target = LEVELS[level]!(b);
    const own = JSON.parse('{"__proto__": {"confirm": true}}') as Obj;
    Object.defineProperty(target, "__proto__", Object.getOwnPropertyDescriptor(own, "__proto__")!);
    // The same body as a request carries it: JSON text, parsed again.
    const parsed = JSON.parse(JSON.stringify(b)) as unknown;
    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(parseDeclarationPutBody(b)).toEqual({ ok: false, reason: "invalid_input" });
    expect(parseDeclarationPutBody(parsed)).toEqual({ ok: false, reason: "invalid_input" });
  },
);

test.prop([fc.integer({ min: 0, max: LEVELS.length - 1 }), fc.nat()])(
  "a missing key at any level gives invalid_input",
  (level, pick) => {
    const b = structuredClone(body()) as unknown as Obj;
    const target = LEVELS[level]!(b);
    const keys = Object.keys(target);
    delete target[keys[pick % keys.length]!];
    expect(parseDeclarationPutBody(b).ok).toBe(false);
  },
);
