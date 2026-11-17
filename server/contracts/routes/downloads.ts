import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// DAN-931 (S-1H.5, Ductus#1836 UGOVOR w931a): the manifest of the desktop
// packages, a contract without a handler (DAN-932). Desktop is Windows and
// macOS (D-296). The place of a package is not decided here (D-306 t. 1 names
// /preuzimanje/ on the same address), so `url` takes a root path or https now:
// widening a pattern later is a new major (breaking.ts).
const END = "(?![\\s\\S])";
// A DNS label: at most 63 characters, no hyphen at either end, and never a
// reserved label with "--" at positions 3 and 4 (RFC 5891 4.2.3.1), which
// covers punycode xn--: parsers disagree on those (Node keeps xn--a, IDNA
// in a browser or a desktop web view refuses it).
const NOT_RESERVED = "(?![a-z0-9]{2}--)";
const LABEL = `${NOT_RESERVED}[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
// A name with a dot whose last label starts with a letter: no IP, no
// localhost, no port, no user.
const HOST = `${LABEL}(?:\\.${LABEL})*\\.${NOT_RESERVED}[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`;
// RFC 3986 path and query characters; no fragment, no backslash, no space.
// The path names a file: it does not start with a second slash or a query.
const PCHAR = "(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})";
// No dot segment, written or encoded (WHATWG reads %2e as a dot), no NUL.
const NO_DOTS = `(?![\\s\\S]*(?:%2[eE]|%00|/\\.\\.?(?:[/?]|${END})))`;
// DNS: the whole name is at most 253 characters (RFC 1035 2.3.4, without
// the root dot); a host is only [a-z0-9.-] and ends at the first slash.
const HOST_LENGTH = "(?=[a-z0-9.-]{1,253}/)";
const URL_PATTERN = `^${NO_DOTS}(?:https://${HOST_LENGTH}${HOST})?/(?![/?])${PCHAR}+${END}`;

const DOWNLOAD_SYSTEMS = ["windows", "macos"] as const;
const DOWNLOAD_ARCHITECTURES = ["x64", "arm64"] as const;

const oneOf = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));

export const downloadsManifestGet = defineRoute({
  id: "downloads.manifest.get",
  method: "GET",
  path: "/api/v1/downloads/manifest",
  inventory: "app/api/downloads/manifest/route.ts",
  access: "anyone",
  summary:
    "The desktop packages a client may offer: one row per system and architecture at most, by system then architecture. url is a path on this address or an https address; sha256 is the SHA-256 of the package bytes in lowercase hex, which the client checks before it opens the package. An empty list: no package yet. A manifest the server cannot read makes the answer 503, never a partial list.",
  request: {},
  responses: [
    {
      status: 200,
      description: "manifest (an empty list when there is no package yet)",
      body: closed({
        packages: Type.Array(
          closed({
            system: oneOf(DOWNLOAD_SYSTEMS),
            architecture: oneOf(DOWNLOAD_ARCHITECTURES),
            version: Type.String({
              pattern: `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)${END}`,
            }),
            url: Type.String({ pattern: URL_PATTERN, maxLength: 2048 }),
            sha256: Type.String({ pattern: `^[0-9a-f]{64}${END}` }),
          }),
          { maxItems: 4 },
        ),
      }),
    },
  ],
  errors: [error(503, "unavailable")],
});

export const downloadsRoutes = [downloadsManifestGet] as const;
