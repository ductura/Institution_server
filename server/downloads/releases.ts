// DAN-932 (S-1H.5-b): the release configuration of the desktop packages,
// built into dist/server.js as settings/institutions-file.ts is, and frozen.
// No desktop release exists yet, so the manifest is empty. A release adds its
// rows here: system, architecture, version, url and the SHA-256 of the
// package bytes, by system then architecture in code point order. Typed
// `unknown`: it earns its shape only through the downloads service, and only
// the service reads it (not exported from index.ts).
export const DESKTOP_RELEASES: unknown = Object.freeze({ packages: Object.freeze([]) });
