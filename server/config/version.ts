/**
 * The version of this server build, the `version` of package.json;
 * version.test.ts keeps the two equal. A constant, so dist/server.js carries
 * no copy of package.json. Health sends it as serverVersion (S-1M-a, DAN-795).
 */
export const SERVER_VERSION = "0.1.0";
