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
  // Text is built from ASCII only (see sampleText), so btoa-free encoding is safe.
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) bytes.push(text.charCodeAt(i));
  return encodeBase64(bytes);
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
  return String.fromCharCode(...bytes);
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
