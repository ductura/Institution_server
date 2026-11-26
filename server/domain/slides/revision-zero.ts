import { SLIDES_DOCUMENT_KIND, SLIDES_SCHEMA_VERSION, type SlidesDocument } from "./model/index.ts";

/**
 * Revision 0 of every slides work (contract §7): one slide of the layout
 * "titleContent" with no blocks and no notes. Ids are fixed, not random, so
 * every new slides work starts from the same bytes and hash. Changing any
 * value below is a question for the owner.
 */
export const SLIDES_REVISION_ZERO_SLIDE_ID = "00000000-0000-4000-8000-000000000000";

export function slidesRevisionZeroDocument(): SlidesDocument {
  return {
    documentKind: SLIDES_DOCUMENT_KIND,
    schemaVersion: SLIDES_SCHEMA_VERSION,
    slides: [{ id: SLIDES_REVISION_ZERO_SLIDE_ID, layout: "titleContent", blocks: [] }],
  };
}

/** Exact JCS text (RFC 8785) of revision 0. */
export const SLIDES_REVISION_ZERO_JCS =
  '{"documentKind":"slides","schemaVersion":1,"slides":[{"blocks":[],"id":"00000000-0000-4000-8000-000000000000","layout":"titleContent"}]}';

/** SHA-256 of the UTF-8 bytes of `SLIDES_REVISION_ZERO_JCS`, lowercase hex (computed with `sha256sum`). */
export const SLIDES_REVISION_ZERO_SHA256 =
  "f593200307d93c988cc050521ab02853510a424d59763d575de83fda1cf8a0d8";
