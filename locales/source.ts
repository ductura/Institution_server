/**
 * Where the catalogues came from (S-1L.1, DAN-768): Ductus
 * `src/lib/i18n/messages.hr.ts` and `messages.en.ts` at the commit below.
 * `source.test.ts` proves that no text changed in the port: it maps every text
 * back to its source path and compares a digest of all (path, text) pairs with
 * the one taken from the source. `scripts/locales/source-digest.ts` takes the
 * same digest from a Ductus checkout, so a reviewer can recompute the values
 * below instead of trusting them.
 */
import { createHash } from "node:crypto";

export const SOURCE = {
  repository: "danielrisavi77-create/Ductus",
  commit: "d52a92c3a108f3f0ec9c3639188a2ea669bba582",
  hr: { path: "src/lib/i18n/messages.hr.ts", blob: "c3ea20e25a91fdd91657fb95d80bf1ba20d5405b" },
  en: { path: "src/lib/i18n/messages.en.ts", blob: "601b40dd151330979b52365757d72de3f9a2f238" },
} as const;

/** Texts in each source table, and the SHA-256 of their (source path, text) pairs. */
export const SOURCE_DIGESTS = {
  hr: {
    texts: 1375,
    sha256: "8430991d9c9677fef09be92d195d03d58dd2e3af1cebc475ed93e09f5880cf9c",
  },
  en: {
    texts: 1375,
    sha256: "b8d6022efe12157957b0c20a93660b54c816567a3e8feac1c63c7c9b366b17f6",
  },
} as const;

/**
 * Keys renamed in the port, the only change it made: Croatian keys became
 * English (the source path on the left, its last segment renamed on the right).
 */
export const SOURCE_KEY_RENAMES: readonly (readonly [source: string, port: string])[] = [
  ["workspace.upute", "workspace.instructions"],
  ["workspace.rad", "workspace.work"],
  ["prijava", "signIn"],
  ["statusPage.states.radi", "statusPage.states.working"],
  ["statusPage.states.ne_radi", "statusPage.states.notWorking"],
  ["statusPage.states.nije_ukljuceno", "statusPage.states.notEnabled"],
];

type TextPair = readonly [path: readonly string[], text: string];

/** Every text of a table with its path as segments. */
export function textPairs(table: unknown): TextPair[] {
  const pairs: TextPair[] = [];
  const walk = (node: unknown, path: readonly string[]): void => {
    if (typeof node === "string") pairs.push([path, node]);
    else if (typeof node === "object" && node !== null)
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  walk(table, []);
  return pairs;
}

/** The path a ported text had in the source table. */
export function sourcePath(path: readonly string[]): string[] {
  for (const [source, port] of SOURCE_KEY_RENAMES) {
    const segments = port.split(".");
    if (segments.every((segment, at) => path[at] === segment))
      return [...source.split("."), ...path.slice(segments.length)];
  }
  return [...path];
}

/** SHA-256 of all (path, text) pairs of a table, paths taken through `toPath`. */
export function digestOf(
  table: unknown,
  toPath: (path: readonly string[]) => readonly string[] = (path) => path,
): { texts: number; sha256: string } {
  const pairs = textPairs(table).map(([path, text]) => [toPath(path), text] as const);
  const ordered = [...pairs].sort((a, b) => {
    const [x, y] = [JSON.stringify(a[0]), JSON.stringify(b[0])];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return {
    texts: ordered.length,
    sha256: createHash("sha256").update(JSON.stringify(ordered)).digest("hex"),
  };
}
