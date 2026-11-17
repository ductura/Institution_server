// DAN-947: one table of hostile inputs for every validator, parser and guard,
// so each refuses the same classes instead of its own short list. Escapes only:
// a raw NBSP, DEL or lone surrogate would not survive editors and review.

export type HostileString = Readonly<{ name: string; value: string }>;
export type HostileJson = Readonly<{ name: string; text: string }>;
/** What a strict reader of exact own data keys must answer: wrong keys or an accessor. */
export type HostileRefusal = "fields" | "accessor";
export type HostileObject = Readonly<{
  name: string;
  value: unknown;
  refusal: HostileRefusal;
  /** Calls of the getter or of the `get` and `has` traps so far; a reader must leave it at 0. */
  touched: () => number;
}>;

const freeze = <T>(items: T[]): readonly T[] => Object.freeze(items.map((i) => Object.freeze(i)));

/** Each class around a valid value, so a validator that trims or normalises is caught too. */
export function hostileStrings(valid: string): readonly HostileString[] {
  const around: [string, string][] = [
    ["yaml-escape", `${valid}\\n`],
    ["yaml-mapping", `${valid}: x`],
    ["yaml-sequence", `- ${valid}`],
    ["yaml-comment", `#${valid}`],
    ["double-quoted-key", `"${valid}"`],
    ["single-quoted-key", `'${valid}'`],
    ["lone-high-surrogate", `${valid}\uD800`],
    ["lone-low-surrogate", `\uDC00${valid}`],
    ["crlf", `${valid}\r\n`],
    ["cr", `${valid}\r`],
    ["lf", `${valid}\n`],
    ["tab", `${valid}\t`],
    ["nbsp", `${valid}\u00A0`],
    ["del", `${valid}\u007F`],
    ["leading-space", ` ${valid}`],
    ["trailing-slash", `${valid}/`],
    ["windows-path", `C:\\${valid}`],
    ["empty", ""],
    ["space", " "],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["constructor", "constructor"],
  ];
  return freeze(around.map(([name, value]) => ({ name, value })));
}

export const HOSTILE_STRINGS: readonly HostileString[] = hostileStrings("a");

/** Names an object inherits from Object.prototype, or that set its prototype. */
export const HOSTILE_KEYS: readonly string[] = Object.freeze([
  "__proto__",
  "toString",
  "constructor",
  "valueOf",
  "hasOwnProperty",
]);

/** JSON texts the consumer parses itself. */
export const HOSTILE_JSON: readonly HostileJson[] = freeze([
  { name: "null", text: "null" },
  { name: "[]", text: "[]" },
  { name: "[null]", text: "[null]" },
]);

const data = (value: unknown): PropertyDescriptor => ({
  value,
  enumerable: true,
  writable: true,
  configurable: true,
});

/**
 * Variants of a valid plain object with at least one key, each a fresh copy:
 * every HOSTILE_KEYS name as an extra own key (defineProperty, so `__proto__`
 * is a key and not the prototype), the first key only inherited, the first key
 * as a getter, and a Proxy that also reports `toString` among its own keys.
 */
export function hostileObjects(valid: Readonly<Record<string, unknown>>): readonly HostileObject[] {
  const [first, ...rest] = Object.keys(valid);
  if (first === undefined) throw new Error("hostileObjects needs a valid object with a key");
  const copy = (): Record<string, unknown> => ({ ...valid });
  const without = Object.fromEntries(rest.map((key) => [key, valid[key]]));
  const variants: HostileObject[] = HOSTILE_KEYS.map((key) => ({
    name: `own ${key}`,
    value: Object.defineProperty(copy(), key, data("x")),
    refusal: "fields",
    touched: () => 0,
  }));
  variants.push({
    name: `inherited ${first}`,
    value: Object.assign(Object.create({ [first]: valid[first] }) as object, without),
    refusal: "fields",
    touched: () => 0,
  });
  let getterCalls = 0;
  const getter = copy();
  Object.defineProperty(getter, first, {
    enumerable: true,
    configurable: true,
    get: () => ((getterCalls += 1), valid[first]),
  });
  variants.push({
    name: `getter ${first}`,
    value: getter,
    refusal: "accessor",
    touched: () => getterCalls,
  });
  let trapCalls = 0;
  // The target is a fresh extensible copy: ownKeys may then report an extra key.
  const proxy = new Proxy(copy(), {
    ownKeys: (target) => [...Reflect.ownKeys(target), "toString"],
    get: (target, key) => ((trapCalls += 1), Reflect.get(target, key) as unknown),
    has: (target, key) => ((trapCalls += 1), Reflect.has(target, key)),
  });
  variants.push({
    name: "proxy with toString",
    value: proxy,
    refusal: "fields",
    touched: () => trapCalls,
  });
  return freeze(variants);
}
