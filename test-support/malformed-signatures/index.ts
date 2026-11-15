// Spellings of a valid raw Ed25519 signature (86 base64url characters) that
// every SigningKeyProvider must answer as not verified. Most are what lenient
// `Buffer.from(…, "base64url")` decoding would turn back into the same 64
// bytes (reviews c.6886569170 and c.6886566065 on ductura/server#27).

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The last of 86 characters carries 2 data bits and 4 unused ones; set the lowest. */
function flipStrayBit(valid: string): string {
  return `${valid.slice(0, -1)}${BASE64URL[BASE64URL.indexOf(valid.at(-1) ?? "A") ^ 1]}`;
}

/** [name, spell] pairs; `spell` turns a valid signature into a malformed one. */
export const MALFORMED_SIGNATURE_SPELLINGS: ReadonlyArray<
  readonly [string, (valid: string) => string]
> = [
  ["an appended !", (valid) => `${valid}!`],
  ["an inserted !", (valid) => `${valid.slice(0, 10)}!${valid.slice(10)}`],
  ["an appended space", (valid) => `${valid} `],
  ["an inserted space", (valid) => `${valid.slice(0, 10)} ${valid.slice(10)}`],
  ["= padding", (valid) => `${valid}==`],
  ["+ and / instead of - and _", (valid) => valid.replaceAll("-", "+").replaceAll("_", "/")],
  ["stray trailing bits", flipStrayBit],
  ["characters after = padding", (valid) => `${valid}=AAAA`],
  ["a value one character short", (valid) => valid.slice(0, -1)],
  ["a value four characters short", (valid) => valid.slice(0, -4)],
  ["a value one character long", (valid) => `${valid}A`],
  ["a value four characters long", (valid) => `${valid}AAAA`],
  ["an empty value", () => ""],
];

/** True when the + and / spelling of a signature differs from it. */
export function hasDashAndUnderscore(signature: string): boolean {
  return signature.includes("-") && signature.includes("_");
}
