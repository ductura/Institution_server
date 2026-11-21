// A strict, bounded XML reader for the parts of a DOCX (SRV-1803, M8.2; ADR
// docs/adr/import-contract.md attack class X). It reads only what OOXML needs:
// one root element, elements, attributes with namespaces, text, CDATA and
// comments. A DOCTYPE or ENTITY declaration is XML_DTD and nothing is ever
// expanded: only the five predefined entities and character references are
// decoded, once (X1). Nesting deeper than the limit is XML_TOO_DEEP (X2), an
// element with more attributes than the limit is XML_TOO_MANY_ATTRIBUTES,
// counted while reading the tag (X3). Processing instructions other than the
// declaration, bytes that are not strict UTF-8, an undeclared prefix, a
// duplicate attribute or anything malformed are XML_INVALID (X5). The input
// is never quoted in a refusal.
import type { ImportReadRejectCode } from "../../contracts/index.ts";
import { decodeStrictUtf8 } from "../../domain/index.ts";

export type XmlAttribute = { readonly ns: string; readonly local: string; readonly value: string };
export type XmlElement = {
  readonly ns: string;
  readonly local: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: (XmlElement | string)[];
};
export type XmlLimits = { readonly maxDepth: number; readonly maxAttributes: number };
export type XmlRead =
  | { readonly ok: true; readonly root: XmlElement }
  | { readonly ok: false; readonly code: ImportReadRejectCode };

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const NAME = /[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/y;
const SPACE = /[ \t\r\n]*/y;
const ONLY_SPACE = /^[ \t\r\n]*$/;
const DECLARATION =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])1\.[0-9]\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z0-9._-]+)\2)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(?:yes|no)\4)?[ \t\r\n]*\?>/;
const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/** Thrown inside the reader; turned into a refusal at its edge. */
class Refusal extends Error {
  constructor(readonly code: ImportReadRejectCode) {
    super(code);
  }
}

function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/** Decodes the predefined entities and character references, once. */
function decodeReferences(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&]{0,16});|&/g, (match, body: string | undefined) => {
    if (body === undefined) throw new Refusal("XML_INVALID");
    const named = PREDEFINED[body];
    if (named !== undefined && Object.hasOwn(PREDEFINED, body)) return named;
    const numeric = /^#(?:x([0-9A-Fa-f]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (numeric === null) throw new Refusal("XML_INVALID");
    const codePoint = numeric[1] !== undefined ? parseInt(numeric[1], 16) : Number(numeric[2]);
    if (!isXmlChar(codePoint)) throw new Refusal("XML_INVALID");
    return String.fromCodePoint(codePoint);
  });
}

type Pending = {
  readonly prefix: string;
  readonly local: string;
  readonly raw: { name: string; value: string }[];
};

/** Reads one part. `bytes` must be UTF-8; a leading BOM is allowed. */
export function readXml(bytes: Uint8Array, limits: XmlLimits): XmlRead {
  let text = decodeStrictUtf8(bytes);
  if (text === null) return { ok: false, code: "XML_INVALID" };
  if (text.startsWith("﻿")) text = text.slice(1);
  try {
    return { ok: true, root: parse(text, limits) };
  } catch (thrown) {
    if (thrown instanceof Refusal) return { ok: false, code: thrown.code };
    throw thrown;
  }
}

function parse(text: string, limits: XmlLimits): XmlElement {
  let at = 0;
  const declaration = DECLARATION.exec(text);
  if (declaration !== null) {
    const encoding = declaration[3];
    if (encoding !== undefined && encoding.toLowerCase() !== "utf-8") {
      throw new Refusal("XML_INVALID");
    }
    at = declaration[0].length;
  } else if (text.startsWith("<?xml")) {
    throw new Refusal("XML_INVALID");
  }
  // A DOCTYPE or an entity declaration anywhere is refused before anything else (X1).
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Refusal("XML_DTD");

  const stack: { element: XmlElement; scope: Map<string, string> }[] = [];
  let root: XmlElement | null = null;
  const rootScope = new Map<string, string>([
    ["xml", XML_NS],
    ["xmlns", XMLNS_NS],
  ]);

  const skipSpace = () => {
    SPACE.lastIndex = at;
    SPACE.exec(text);
    at = SPACE.lastIndex;
  };
  const readName = (): string => {
    NAME.lastIndex = at;
    const match = NAME.exec(text);
    if (match === null) throw new Refusal("XML_INVALID");
    at = NAME.lastIndex;
    return match[0];
  };
  const appendText = (value: string) => {
    if (value === "") return;
    const top = stack.at(-1);
    if (top === undefined) {
      if (!ONLY_SPACE.test(value)) throw new Refusal("XML_INVALID");
      return;
    }
    const children = top.element.children;
    const last = children.at(-1);
    if (typeof last === "string") children[children.length - 1] = last + value;
    else children.push(value);
  };

  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1) {
      appendText(decodeReferences(text.slice(at)));
      break;
    }
    if (open > at) {
      const raw = text.slice(at, open);
      if (raw.includes("]]>")) throw new Refusal("XML_INVALID");
      appendText(decodeReferences(raw));
    }
    at = open;
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at + 4);
      if (end === -1) throw new Refusal("XML_INVALID");
      at = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", at)) {
      const end = text.indexOf("]]>", at + 9);
      if (end === -1 || stack.length === 0) throw new Refusal("XML_INVALID");
      appendText(text.slice(at + 9, end));
      at = end + 3;
      continue;
    }
    // Any other markup declaration or processing instruction (X5).
    if (text.startsWith("<!", at) || text.startsWith("<?", at)) throw new Refusal("XML_INVALID");
    if (text.startsWith("</", at)) {
      at += 2;
      const name = readName();
      skipSpace();
      if (text[at] !== ">") throw new Refusal("XML_INVALID");
      at += 1;
      const top = stack.pop();
      if (top === undefined) throw new Refusal("XML_INVALID");
      const [prefix, local] = splitName(name);
      if (top.element.local !== local || resolve(top.scope, prefix) !== top.element.ns) {
        throw new Refusal("XML_INVALID");
      }
      continue;
    }

    at += 1;
    const name = readName();
    const [prefix, local] = splitName(name);
    const pending: Pending = { prefix, local, raw: [] };
    let selfClosing = false;
    for (;;) {
      const before = at;
      skipSpace();
      if (text.startsWith("/>", at)) {
        selfClosing = true;
        at += 2;
        break;
      }
      if (text[at] === ">") {
        at += 1;
        break;
      }
      if (at === before) throw new Refusal("XML_INVALID");
      if (pending.raw.length >= limits.maxAttributes) throw new Refusal("XML_TOO_MANY_ATTRIBUTES");
      const attributeName = readName();
      skipSpace();
      if (text[at] !== "=") throw new Refusal("XML_INVALID");
      at += 1;
      skipSpace();
      const quote = text[at];
      if (quote !== '"' && quote !== "'") throw new Refusal("XML_INVALID");
      const end = text.indexOf(quote, at + 1);
      if (end === -1) throw new Refusal("XML_INVALID");
      const rawValue = text.slice(at + 1, end);
      if (rawValue.includes("<")) throw new Refusal("XML_INVALID");
      at = end + 1;
      if (pending.raw.some((attribute) => attribute.name === attributeName)) {
        throw new Refusal("XML_INVALID");
      }
      pending.raw.push({ name: attributeName, value: decodeReferences(rawValue) });
    }

    if (root !== null && stack.length === 0) throw new Refusal("XML_INVALID");
    if (stack.length + 1 > limits.maxDepth) throw new Refusal("XML_TOO_DEEP");
    const parentScope = stack.at(-1)?.scope ?? rootScope;
    const element = build(pending, parentScope);
    const top = stack.at(-1);
    if (top === undefined) root = element.element;
    else top.element.children.push(element.element);
    if (!selfClosing) stack.push(element);
  }
  if (stack.length !== 0 || root === null) throw new Refusal("XML_INVALID");
  return root;
}

function splitName(name: string): [string, string] {
  const colon = name.indexOf(":");
  return colon === -1 ? ["", name] : [name.slice(0, colon), name.slice(colon + 1)];
}

function resolve(scope: ReadonlyMap<string, string>, prefix: string): string {
  const ns = scope.get(prefix);
  if (ns === undefined) {
    if (prefix === "") return "";
    throw new Refusal("XML_INVALID");
  }
  return ns;
}

function build(
  pending: Pending,
  parentScope: ReadonlyMap<string, string>,
): { element: XmlElement; scope: Map<string, string> } {
  let scope: Map<string, string> | null = null;
  for (const { name, value } of pending.raw) {
    if (name === "xmlns" || name.startsWith("xmlns:")) {
      scope ??= new Map(parentScope);
      const prefix = name === "xmlns" ? "" : name.slice(6);
      if (prefix === "xml" || prefix === "xmlns") throw new Refusal("XML_INVALID");
      if (prefix !== "" && value === "") throw new Refusal("XML_INVALID");
      scope.set(prefix, value);
    }
  }
  const own = scope ?? new Map(parentScope);
  const attributes: XmlAttribute[] = [];
  const seen = new Set<string>();
  for (const { name, value } of pending.raw) {
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    const [prefix, local] = splitName(name);
    // An unprefixed attribute has no namespace, whatever the default is.
    const ns = prefix === "" ? "" : resolve(own, prefix);
    const key = `${ns}|${local}`;
    if (seen.has(key)) throw new Refusal("XML_INVALID");
    seen.add(key);
    attributes.push({ ns, local, value });
  }
  return {
    element: { ns: resolve(own, pending.prefix), local: pending.local, attributes, children: [] },
    scope: own,
  };
}

/** The value of one attribute, or undefined. */
export function attributeOf(element: XmlElement, ns: string, local: string): string | undefined {
  return element.attributes.find((a) => a.local === local && a.ns === ns)?.value;
}

/** The element children, without text. */
export function elementsOf(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== "string");
}
