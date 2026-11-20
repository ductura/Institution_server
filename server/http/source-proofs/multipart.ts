// The multipart/form-data body of student.source-proofs.post (SRV-1102, RFC
// 7578). Only what the route needs: the boundary from the content type, then
// each part with its name, whether it is a file (a filename is given) and its
// bytes. A part without a name, a repeated name, a missing closing delimiter
// or anything after it is a broken body. Nothing is decoded here beyond the
// part headers; the route checks the fields.

/** RFC 2046 §5.1.1: 1 to 70 characters, not ending in a space; quoted or not. */
const BOUNDARY =
  /^multipart\/form-data\s*;\s*boundary=(?:"([0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?])"|([0-9A-Za-z'()+_\-./:=?]{1,70}))\s*$/iu;
const NAME = /;\s*name="([^"\r\n]*)"/iu;
const FILENAME = /;\s*filename="/iu;
const DISPOSITION = /^content-disposition:\s*form-data\s*;/iu;
const CRLF = Buffer.from("\r\n");
const HEAD_END = Buffer.from("\r\n\r\n");

export type FormPart = { readonly file: boolean; readonly bytes: Buffer };

/** The boundary of a multipart/form-data content type, or undefined for any other type. */
export function boundaryOf(contentType: string): string | undefined {
  const match = BOUNDARY.exec(contentType);
  return match === null ? undefined : (match[1] ?? match[2]);
}

/** The parts of the body by name, or null for a broken body. */
export function parseMultipart(body: Buffer, boundary: string): Map<string, FormPart> | null {
  const dash = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.concat([CRLF, dash]);
  // The body starts with the first delimiter (no preamble is sent by a browser).
  if (!body.subarray(0, dash.length).equals(dash)) return null;
  const parts = new Map<string, FormPart>();
  let at = dash.length;
  for (;;) {
    const after = body.subarray(at, at + 2).toString("latin1");
    if (after === "--") {
      // The closing delimiter, then at most one line break.
      const rest = body.subarray(at + 2);
      return rest.length === 0 || rest.equals(CRLF) ? parts : null;
    }
    if (after !== "\r\n") return null;
    const start = at + 2;
    const headEnd = body.indexOf(HEAD_END, start);
    if (headEnd < 0) return null;
    const next = body.indexOf(delimiter, headEnd + HEAD_END.length);
    if (next < 0) return null;
    const lines = body.subarray(start, headEnd).toString("latin1").split("\r\n");
    const disposition = lines.filter((line) => DISPOSITION.test(line));
    if (disposition.length !== 1) return null;
    const name = NAME.exec(disposition[0]!)?.[1];
    if (name === undefined || name.length === 0 || parts.has(name)) return null;
    parts.set(name, {
      file: FILENAME.test(disposition[0]!),
      bytes: body.subarray(headEnd + HEAD_END.length, next),
    });
    at = next + delimiter.length;
  }
}
