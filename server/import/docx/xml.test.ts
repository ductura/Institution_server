// SRV-1803: the strict XML reader of an imported DOCX part, beyond the
// attack rows read-docx.test.ts drives through a whole package: namespace
// bindings and the cost of large but allowed parts (review findings on #542).
// Every input is invented.
import { describe, expect, it } from "vitest";

import { readXml } from "./xml.ts";

const LIMITS = { maxDepth: 128, maxAttributes: 2000 };
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const read = (text: string) => readXml(new TextEncoder().encode(text), LIMITS);
const codeOf = (text: string) => {
  const result = read(text);
  return result.ok ? "ok" : result.code;
};

describe("readXml: namespace bindings", () => {
  it("accepts an explicit declaration of the xml prefix with its own name", () => {
    expect(codeOf(`<r xmlns:xml="${XML_NS}" xml:space="preserve"/>`)).toBe("ok");
    const result = read(`<r xmlns:xml="${XML_NS}" xml:space="preserve"/>`);
    expect(result.ok && result.root.attributes).toEqual([
      { ns: XML_NS, local: "space", value: "preserve" },
    ]);
  });

  it("refuses rebinding xml, binding its name to another prefix and declaring xmlns", () => {
    expect(codeOf('<r xmlns:xml="urn:drugo"/>')).toBe("XML_INVALID");
    expect(codeOf(`<r xmlns:x="${XML_NS}"/>`)).toBe("XML_INVALID");
    expect(codeOf(`<r xmlns="${XML_NS}"/>`)).toBe("XML_INVALID");
    expect(codeOf('<r xmlns:xmlns="urn:drugo"/>')).toBe("XML_INVALID");
  });

  it("keeps a declaration to its element and its descendants", () => {
    const result = read('<r><a xmlns:p="urn:p"><p:b/></a><c/></r>');
    expect(result.ok).toBe(true);
    expect(codeOf('<r><a xmlns:p="urn:p"/><p:b/></r>')).toBe("XML_INVALID");
  });
});

describe("readXml: the cost of a large allowed part", () => {
  it("does not copy the namespace scope for every element", () => {
    const prefixes = Array.from({ length: 1500 }, (_, i) => ` xmlns:p${i}="urn:x:${i}"`).join("");
    const started = performance.now();
    expect(codeOf(`<r${prefixes}>${"<e/>".repeat(100_000)}</r>`)).toBe("ok");
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("finds a duplicate attribute without scanning the attributes read before", () => {
    const attributes = Array.from({ length: 1999 }, (_, i) => ` a${i}="v"`).join("");
    const started = performance.now();
    expect(codeOf(`<r>${`<e${attributes}/>`.repeat(600)}</r>`)).toBe("ok");
    expect(performance.now() - started).toBeLessThan(3000);
    expect(codeOf(`<r><e${attributes} a1998="w"/></r>`)).toBe("XML_INVALID");
  });
});
