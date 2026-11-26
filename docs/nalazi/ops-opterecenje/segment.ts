// Builds invented evidence commits for the load test (ops-opterecenje).
// Pure ES module with no k6 imports, so it runs under Node as well; the hash
// function is passed in (k6: crypto.sha256, Node: node:crypto). Mirrors the
// shape of server/contracts/vectors/evidence.commit.post.json: a segment of
// the format ductus-evidence-segment-v2 in RFC 8785 canonical form, and the
// canonical document, both base64.

const SEGMENT_SCHEMA = "ductus-evidence-segment-v2";

/** RFC 8785 for the data used here: ASCII keys, no floats; strings via JSON.stringify. */
export function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const b64 = (text) => {
  return encodeBase64(utf8Bytes(text));
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : "=";
  }
  return out;
}

export function decodeBase64(text) {
  const clean = text.replace(/=+$/u, "");
  const bytes = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = (acc << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
    }
  }
  return utf8Text(bytes);
}

/** UTF-8 bytes of a string (code points, so emoji and Croatian letters survive). */
function utf8Bytes(text) {
  const bytes = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return bytes;
}

function utf8Text(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    let cp = n === 1 ? b : b & (0xff >> (n + 1));
    for (let k = 1; k < n; k += 1) cp = (cp << 6) | (bytes[i + k] & 63);
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

/** Invented ASCII text for a student's n-th save. */
export function sampleText(student, n) {
  return `Izmisljeni dio ${n} rada ${student}. `;
}

function minute(ms) {
  return new Date(Math.floor(ms / 60000) * 60000).toISOString();
}

/**
 * One commit request body, built from the answer of evidence.open (or of the
 * previous commit). `state` is { documentId, revision, document (parsed),
 * headSegmentHash, lastSequenceTo, sessionId }; returns { body, next }.
 * The text goes at the end of the first paragraph; positions follow the
 * ProseMirror model of the vector: position 1 is inside the first paragraph.
 */
/** Document versions whose works take ductus-edit-steps-v1 (the format this builder emits). */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2];

export function buildCommit(state, text, nowMs, sha256Hex, tag) {
  const doc = state.document;
  const first = doc.nodes[0];
  const before = sha256Hex(canon(doc));
  const length = first.children.reduce((sum, c) => sum + c.text.length, 0);
  const position = 1 + length;
  const nextDoc = JSON.parse(JSON.stringify(doc));
  // Adjacent text with the same marks is one node (as after a real insert).
  const kids = nextDoc.nodes[0].children;
  if (kids.length > 0) kids[kids.length - 1].text += text;
  else kids.push({ marks: [], text, type: "text" });
  const canonicalDoc = canon(nextDoc);
  const after = sha256Hex(canonicalDoc);
  const from = state.lastSequenceTo + 1;
  const segment = {
    canonicalization: "RFC8785-JCS",
    captureContext: { editorModel: "prosemirror", transactionFormat: "ductus-edit-steps-v1" },
    documentId: state.documentId,
    events: [
      {
        afterDocumentHash: after,
        beforeDocumentHash: before,
        sequence: from,
        source: "editor",
        steps: [
          {
            from: position,
            slice: { content: [{ text, type: "text" }] },
            stepType: "replace",
            to: position,
          },
        ],
        touchedNodeIds: [first.id],
      },
    ],
    evidenceProfileId: state.evidenceProfileId ?? "standard-v1",
    evidenceSchema: SEGMENT_SCHEMA,
    finalDocumentHash: after,
    hashAlgorithm: "sha256",
    initialDocumentHash: before,
    observedEndedAt: minute(nowMs),
    observedStartedAt: minute(nowMs),
    predecessorSegmentHash: state.headSegmentHash,
    segmentId: `${state.sessionId}-s${from}`,
    sequenceFrom: from,
    sequenceTo: from,
    sessionId: state.sessionId,
  };
  const canonicalSegment = canon(segment);
  return {
    body: {
      documentId: state.documentId,
      clientTransactionId: `${tag}-${from}`,
      baseRevision: state.revision,
      segments: [b64(canonicalSegment)],
      document: b64(canonicalDoc),
    },
    segmentHash: sha256Hex(canonicalSegment),
    next: { ...state, document: nextDoc, lastSequenceTo: from },
  };
}
