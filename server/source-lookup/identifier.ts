export type SourceIdentifier = { kind: "doi" | "isbn"; value: string };

export const SOURCE_IDENTIFIER_MAX_LENGTH = 512;

function doiFrom(input: string): string | null {
  const original = input.replace(/^doi:\s*/iu, "");
  const resolver = /^https?:\/\/(?:dx\.)?doi\.org\//iu.exec(original);
  let value = original;
  if (resolver) {
    try {
      value = decodeURIComponent(original.slice(resolver[0].length).split(/[?#]/u, 1)[0] ?? "");
    } catch {
      return null;
    }
  }
  value = value.toLowerCase();
  return value.length <= SOURCE_IDENTIFIER_MAX_LENGTH &&
    /^10\.\d{4,9}\/.+/u.test(value) &&
    !/[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
    ? value
    : null;
}

function isbnFrom(input: string): string | null {
  const value = input
    .replace(/^isbn(?:-1[03])?(?::\s*|\s+)/iu, "")
    .replace(/[-\p{White_Space}]/gu, "")
    .toUpperCase();
  const ten = /^[0-9]{9}[0-9X]$/u.test(value);
  if (!ten && !/^97[89][0-9]{10}$/u.test(value)) return null;
  const sum = Array.from(value).reduce((total, digit, index) => {
    const weight = ten ? 10 - index : (index % 2) * 2 + 1;
    return total + weight * (digit === "X" ? 10 : Number(digit));
  }, 0);
  return sum % (ten ? 11 : 10) === 0 ? value : null;
}

export function parseSourceIdentifier(kind: unknown, raw: unknown): SourceIdentifier | null {
  if (typeof raw !== "string" || raw.length > SOURCE_IDENTIFIER_MAX_LENGTH) return null;
  if (kind !== "doi" && kind !== "isbn") return null;
  const value = kind === "doi" ? doiFrom(raw.trim()) : isbnFrom(raw.trim());
  return value === null ? null : { kind, value };
}
