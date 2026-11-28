// M3.1 (B-8), N-19 of plan #1504 (DAN-707): the closed object of an evidence
// body refuses a key written twice. Identifiers are invented.
import { describe, expect, it } from "vitest";

import { objectKeysWritten, parseClosedJsonObject } from "./closed-object.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const KEYS = ["documentId", "from"];
const parse = (text: string, keys: readonly string[] = KEYS) =>
  parseClosedJsonObject(new TextEncoder().encode(text), keys);

describe("parseClosedJsonObject", () => {
  it("takes an object with exactly the keys, in any order and with nested values", () => {
    expect(parse(`{"documentId":"${A}","from":1}`)).toEqual({ documentId: A, from: 1 });
    expect(parse(` { "from" : 2 , "documentId" : "${A}" } `)).toEqual({ documentId: A, from: 2 });
    expect(parse(`{"documentId":["a,\\"b\\"",{"x":1,"x":2}],"from":{"y":[1,{"z":3}]}}`)).toEqual({
      documentId: ['a,"b"', { x: 2 }],
      from: { y: [1, { z: 3 }] },
    });
  });

  it.each([
    ["a key written twice", `{"documentId":"${A}","documentId":"${B}","from":1}`],
    ["the same value twice", `{"documentId":"${A}","from":1,"from":1}`],
    ["a repeat spelt with an escape", `{"documentId":"${A}","\\u0064ocumentId":"${B}","from":1}`],
    ["a repeat after a value with braces", `{"documentId":"{\\"from\\":1}","from":1,"from":2}`],
    ["a repeat of __proto__", `{"__proto__":1,"__proto__":2}`],
  ])("N-19: %s is null", (_name, text) => {
    const keys = text.startsWith('{"__proto__"') ? ["__proto__"] : KEYS;
    expect(parse(text, keys)).toBeNull();
  });

  it.each([
    ["an empty body", ""],
    ["null", "null"],
    ["an array", `["${A}"]`],
    ["trailing data", `{"documentId":"${A}","from":1} {}`],
    ["a missing key", `{"documentId":"${A}"}`],
    ["an unknown key", `{"documentId":"${A}","from":1,"userId":"${B}"}`],
    ["a key only in another case", `{"DocumentId":"${A}","from":1}`],
  ])("B4/B5: %s is null", (_name, text) => {
    expect(parse(text)).toBeNull();
  });

  it("B4: a byte order mark and invalid UTF-8 are null, never skipped or replaced", () => {
    const body = new TextEncoder().encode(`{"documentId":"${A}","from":1}`);
    expect(parseClosedJsonObject(new Uint8Array([0xef, 0xbb, 0xbf, ...body]), KEYS)).toBeNull();
    const head = new TextEncoder().encode('{"documentId":"');
    const tail = new TextEncoder().encode('","from":1}');
    expect(parseClosedJsonObject(new Uint8Array([...head, 0xc0, 0xaf, ...tail]), KEYS)).toBeNull();
  });

  it("reads a body of millions of characters in one linear pass", () => {
    const long = "A".repeat(5_000_000);
    expect(parse(`{"documentId":"${long}","from":1}`)?.documentId).toBe(long);
    expect(parse(`{"documentId":"${long}","from":1,"from":2}`)).toBeNull();
  });
});

describe("objectKeysWritten (F4-EDI-R05-SRV B3)", () => {
  it.each([
    ["no object", `"a"`, 0],
    ["an empty object", "{}", 0],
    ["a flat object", `{"a":1,"b":"x"}`, 2],
    ["a nested object", `{"a":{"b":1,"c":[{"d":2},{}]},"e":[1,"f"]}`, 5],
    ["strings that look like keys", `{"a":"{\\"b\\":1,\\"c\\":2}","d":["e","f"]}`, 2],
    ["a key written twice inside", `{"a":{"b":1,"b":2}}`, 3],
    ["keys and values with commas and braces", `{"a,}":"]{,","b":[[],[{}]]}`, 2],
    ["keys and values outside ASCII", `{"ključ":"čšž{","b":{"ž":"\\"},"}}`, 3],
  ])("counts %s", (_name, text, count) => {
    expect(objectKeysWritten(new TextEncoder().encode(text))).toBe(count);
  });

  it.each([
    ["an unclosed key", `{"a`],
    ["an unclosed value", `{"a":"b`],
    ["a backslash at the end", `{"a":"b\\`],
  ])("ends on %s instead of reading past the bytes", (_name, text) => {
    expect(objectKeysWritten(new TextEncoder().encode(text))).toBeLessThanOrEqual(1);
  });
});
