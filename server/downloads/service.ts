// Service of server/downloads: the manifest of the desktop packages (DAN-932,
// S-1H.5-b; UGOVOR Ductus#2028 c.6968257133). The release configuration is
// answered whole or not at all, never as a partial list:
// 1. a copy of its plain data: structuredClone keeps own enumerable fields
//    only and reads a getter once, as a value, so nothing inherited, hidden
//    or live reaches the answer; a function, Proxy or symbol value throws;
// 2. the contract's 200 body (Value.Check over the copy);
// 3. each pair once, by system then architecture in string order
//    (macos before windows, arm64 before x64), which the schema cannot say.
// A refusal is one of three closed codes; it never carries a value.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { AppError, Result } from "../domain/index.ts";

import { DESKTOP_RELEASES } from "./releases.ts";

export type DownloadsPackage = {
  readonly system: string;
  readonly architecture: string;
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
};
export type DownloadsManifest = { readonly packages: readonly DownloadsPackage[] };

const unavailable = (code: string): AppError => ({ code, messageKey: "errors.unavailable" });
/** The configuration could not be read or copied as plain data. */
export const DOWNLOADS_RELEASES_UNREADABLE = unavailable("DOWNLOADS_RELEASES_UNREADABLE");
/** The copy is not the contract's 200 body. */
export const DOWNLOADS_RELEASES_INVALID = unavailable("DOWNLOADS_RELEASES_INVALID");
/** A pair is twice or out of order. */
export const DOWNLOADS_RELEASES_ORDER = unavailable("DOWNLOADS_RELEASES_ORDER");
export const DOWNLOADS_ERRORS: readonly AppError[] = [
  DOWNLOADS_RELEASES_UNREADABLE,
  DOWNLOADS_RELEASES_INVALID,
  DOWNLOADS_RELEASES_ORDER,
];

export type DownloadsService = {
  /** The manifest of the release configuration as it is now; never throws. */
  manifest(): Result<DownloadsManifest>;
};

const BODY = (() => {
  const route = ROUTES.find((r) => r.id === "downloads.manifest.get");
  const body = route?.responses.find((response) => response.status === 200)?.body;
  if (body === undefined) throw new Error("no contract downloads.manifest.get");
  return body;
})();

/** Pairs strictly ascending in string order (ASCII values): sorted and none twice. */
function ascending(packages: readonly DownloadsPackage[]): boolean {
  const keys = packages.map((row) => `${row.system}/${row.architecture}`);
  return keys.every((key, i) => i === 0 || keys[i - 1]! < key);
}

/** Throws when the configuration cannot be read or copied as plain data. */
function read(releases: () => unknown): Result<DownloadsManifest> {
  const value: unknown = structuredClone(releases());
  if (!Value.Check(BODY, value)) return { ok: false, error: DOWNLOADS_RELEASES_INVALID };
  const manifest = value as DownloadsManifest;
  if (!ascending(manifest.packages)) return { ok: false, error: DOWNLOADS_RELEASES_ORDER };
  return { ok: true, value: manifest };
}

/** The manifest service over a reader of the release configuration (the built-in one by default). */
export function createDownloadsService(deps: { releases?: () => unknown } = {}): DownloadsService {
  const releases = deps.releases ?? (() => DESKTOP_RELEASES);
  return {
    manifest() {
      try {
        return read(releases);
      } catch {
        return { ok: false, error: DOWNLOADS_RELEASES_UNREADABLE };
      }
    },
  };
}
