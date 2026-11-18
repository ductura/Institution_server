/**
 * Where the catalogues came from (S-1L.1, DAN-768): Ductus
 * `src/lib/i18n/messages.hr.ts` and `messages.en.ts` at the commit below.
 * `source.test.ts` proves that the port changed no text but the ones in
 * `SOURCE_TEXT_CHANGES`: it puts those back, maps every text back to its source
 * path and compares a digest of all (path, text) pairs with the one taken from
 * the source. `scripts/locales/source-digest.ts` takes the
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
    sha256: "49de20cbd6810ed5c12ab1cba7b2e9195dc3241d18b3493cb7f49140a1ea22cc",
  },
  en: {
    texts: 1375,
    sha256: "1b7dcb2b66aa994a45a12b090b5a39a89698cc08d620dc9cddfbeec30cf56a39",
  },
} as const;

/**
 * Keys renamed in the port: Croatian keys became English (the source path on
 * the left, its last segment renamed on the right).
 */
export const SOURCE_KEY_RENAMES: readonly (readonly [source: string, port: string])[] = [
  ["workspace.upute", "workspace.instructions"],
  ["workspace.rad", "workspace.work"],
  ["prijava", "signIn"],
  ["statusPage.states.radi", "statusPage.states.working"],
  ["statusPage.states.ne_radi", "statusPage.states.notWorking"],
  ["statusPage.states.nije_ukljuceno", "statusPage.states.notEnabled"],
];

const CHANGE_DECISION =
  "https://github.com/danielrisavi77-create/Ductus/issues/1836#issuecomment-6889314023";
const NOUN_FINDING = "https://github.com/ductura/server/pull/38#issuecomment-6889516654";

/**
 * Top-level sections added after the port, with texts Ductus does not have;
 * the source digest is taken without them. `errors`: the texts of the server's
 * error codes (S-1L.3, DAN-789, server/http/problem.ts). `clientErrors`: the
 * error catalogue's texts the contract does not answer (S-1M-c, DAN-802,
 * server/http/error-catalog.ts).
 */
export const SOURCE_ADDITIONS: readonly string[] = ["errors", "clientErrors"];

/**
 * Single texts added after the port inside a ported section; the source digest
 * is taken without them too. `signIn.redirecting`: the notice while the browser
 * goes to AAI@EduHr (DAN-1081, Ductus#2028 c.6965980260).
 */
export const SOURCE_KEY_ADDITIONS: readonly string[] = ["signIn.redirecting"];

/** A text the port changed on purpose: its path in the port, the source text and the new one. */
export type TextChange = {
  readonly language: "hr" | "en";
  readonly path: string;
  readonly source: string;
  readonly port: string;
  readonly decision: string;
};

/**
 * Texts changed in the port, a recorded deviation from the source: PRODUCT §5
 * allows the root "kopir-" / "copy" only in "Kopiraj navod", "kopiranje
 * navoda", "Kopirano u međuspremnik" and "Copy citation" (D-59). Four actions
 * now say "međuspremnik" / "clipboard" in both languages (orchestrator
 * decision), and the English noun "copy" of the sign-out texts became
 * "version" (review finding; Croatian "kopija" is not the root "kopir-" and
 * stays). Each entry links its reason in `decision`. The digest in `SOURCE_DIGESTS` stays the one of the Ductus source.
 */
export const SOURCE_TEXT_CHANGES: readonly TextChange[] = [
  {
    language: "hr",
    path: "workspace.earlierDraftExplain",
    source:
      "Tekst ostaje gdje je i ne briše se. Ako ga želite u ovom radu, kopirajte ga i zalijepite; zapis rada tada to bilježi kao lijepljenje.",
    port: "Tekst ostaje gdje je i ne briše se. Ako ga želite u ovom radu, stavite ga u međuspremnik i zalijepite; zapis rada tada to bilježi kao lijepljenje.",
    decision: CHANGE_DECISION,
  },
  {
    language: "hr",
    path: "workspace.earlierDraftCopy",
    source: "Kopiraj tekst",
    port: "Stavi tekst u međuspremnik",
    decision: CHANGE_DECISION,
  },
  {
    language: "hr",
    path: "revisions.keptHint",
    source:
      "Ovo obrazloženje nije poslano jer se na zahtjev više ne odgovara. Kopirajte ga ako ga želite sačuvati.",
    port: "Ovo obrazloženje nije poslano jer se na zahtjev više ne odgovara. Stavite ga u međuspremnik ako ga želite sačuvati.",
    decision: CHANGE_DECISION,
  },
  {
    language: "hr",
    path: "revisions.keptUnloadedHint",
    source:
      "Ovo obrazloženje nije poslano, a zahtjevi se trenutačno ne mogu učitati. Kopirajte ga ako ga želite sačuvati.",
    port: "Ovo obrazloženje nije poslano, a zahtjevi se trenutačno ne mogu učitati. Stavite ga u međuspremnik ako ga želite sačuvati.",
    decision: CHANGE_DECISION,
  },
  {
    language: "en",
    path: "workspace.earlierDraftExplain",
    source:
      "The text stays where it is and is not deleted. If you want it in this work, copy it and paste it in; the record of the work then logs that as a paste.",
    port: "The text stays where it is and is not deleted. If you want it in this work, put it on the clipboard and paste it in; the record of the work then logs that as a paste.",
    decision: CHANGE_DECISION,
  },
  {
    language: "en",
    path: "workspace.earlierDraftCopy",
    source: "Copy text",
    port: "Put the text on the clipboard",
    decision: CHANGE_DECISION,
  },
  {
    language: "en",
    path: "revisions.keptHint",
    source:
      "This explanation was not sent because the request can no longer be answered. Copy it if you want to keep it.",
    port: "This explanation was not sent because the request can no longer be answered. Put it on the clipboard if you want to keep it.",
    decision: CHANGE_DECISION,
  },
  {
    language: "en",
    path: "revisions.keptUnloadedHint",
    source:
      "This explanation was not sent, and the requests cannot be loaded right now. Copy it if you want to keep it.",
    port: "This explanation was not sent, and the requests cannot be loaded right now. Put it on the clipboard if you want to keep it.",
    decision: CHANGE_DECISION,
  },
  {
    language: "en",
    path: "auth.logoutCopy.one",
    source: "This device keeps {n} copy of text that is not in the work.",
    port: "This device keeps {n} version of text that is not in the work.",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.logoutCopy.few",
    source: "This device keeps {n} copies of text that are not in the work.",
    port: "This device keeps {n} versions of text that are not in the work.",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.logoutCopy.many",
    source: "This device keeps {n} copies of text that are not in the work.",
    port: "This device keeps {n} versions of text that are not in the work.",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.logoutCopyKept",
    source:
      "Signing out does not delete the copy. It stays linked to you on this device, and you see it again when you sign in.",
    port: "Signing out does not delete the version. It stays linked to you on this device, and you see it again when you sign in.",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyTitle",
    source: "Copy of the text",
    port: "Version of the text",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyNewestOnly",
    source: "The actions apply to the newest copy.",
    port: "The actions apply to the newest version.",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyDiscard",
    source: "Discard the copy",
    port: "Discard the version",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyDiscardAsk",
    source: "A discarded copy cannot be restored. Discard it?",
    port: "A discarded version cannot be restored. Discard it?",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyDiscardConfirm",
    source: "Yes, discard the copy",
    port: "Yes, discard the version",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyKeep",
    source: "Keep the copy",
    port: "Keep the version",
    decision: NOUN_FINDING,
  },
  {
    language: "en",
    path: "auth.copyDiscardFailed",
    source: "The copy was not discarded and stays on this device. Try again.",
    port: "The version was not discarded and stays on this device. Try again.",
    decision: NOUN_FINDING,
  },
];

/** A copy of the table without what was added after the port (SOURCE_ADDITIONS, SOURCE_KEY_ADDITIONS). */
export function withoutAdditions<T>(table: T): T {
  const copy = structuredClone(table);
  for (const section of SOURCE_ADDITIONS) {
    if (!isObject(copy) || !Object.hasOwn(copy, section))
      throw new Error(`no added section ${section}`);
    delete copy[section];
  }
  for (const path of SOURCE_KEY_ADDITIONS) {
    const keys = path.split(".");
    const last = keys.pop() ?? "";
    let node: unknown = copy;
    for (const key of keys)
      node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
    if (!isObject(node) || typeof node[last] !== "string" || !Object.hasOwn(node, last))
      throw new Error(`no added text ${path}`);
    delete node[last];
  }
  return copy;
}

/**
 * A copy of `table` without the additions and with each text of
 * `SOURCE_TEXT_CHANGES` for `language` put back to its source text. Throws
 * when a recorded path does not hold the recorded new text, so the list
 * cannot go stale.
 */
export function withSourceTexts<T>(table: T, language: "hr" | "en"): T {
  const copy = withoutAdditions(table);
  for (const change of SOURCE_TEXT_CHANGES.filter((each) => each.language === language)) {
    const keys = change.path.split(".");
    const last = keys.pop() ?? "";
    let node: unknown = copy;
    for (const key of keys)
      node = isObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
    const parent = node;
    if (!isObject(parent) || !Object.hasOwn(parent, last) || parent[last] !== change.port)
      throw new Error(`no recorded text at ${language} ${change.path}`);
    parent[last] = change.source;
  }
  return copy;
}

function isObject(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null;
}

/** A key of an object, or the index (a number) of a list, so the two differ in a digest. */
type Segment = string | number;
type TextPair = readonly [path: readonly Segment[], text: string];

/** Every text of a table with its path as segments. */
export function textPairs(table: unknown): TextPair[] {
  const pairs: TextPair[] = [];
  const walk = (node: unknown, path: readonly Segment[]): void => {
    if (typeof node === "string") pairs.push([path, node]);
    else if (Array.isArray(node)) node.forEach((value, at) => walk(value, [...path, at]));
    else if (typeof node === "object" && node !== null)
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
  };
  walk(table, []);
  return pairs;
}

/** The path a ported text had in the source table. */
export function sourcePath(path: readonly Segment[]): Segment[] {
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
  toPath: (path: readonly Segment[]) => readonly Segment[] = (path) => path,
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
