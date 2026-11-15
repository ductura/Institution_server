/**
 * Version of the published API document (openapi/v1.json), major.minor.patch.
 * The major is the one in API_PREFIX and in the file name. Raise the minor for
 * an added route or field and the patch for a change of text; a change that
 * breaks existing clients is refused (scripts/check-breaking.ts) and needs a
 * new major, which is a new document and a new path prefix.
 */
export const API_VERSION = "1.2.0";
