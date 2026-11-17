// The requests of a signed-in student's browser to the stack's server, shared
// by the commit check (DAN-817) and the functional tests (tests/functional,
// DAN-1003). Moved from vs1-commit-check.ts; since then `post` also settles a
// response cut after its headers and a missing answer (QA on #276). Every
// value is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeJcs } from "../../server/domain/index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** The status, the body exactly as received (UTF-8) and its JSON, or {} when it is not JSON. */
export type Answer = { status: number; text: string; body: Record<string, unknown> };

/** How long one request may take, from sending to the last byte of its answer. */
export const POST_TIMEOUT_MS = 30_000;

/**
 * One POST as the browser of a signed-in student sends it. It always
 * settles: a response cut before its end, a closed connection and an answer
 * not complete within `timeoutMs` of the request (a deadline for the whole
 * exchange, not for a pause between chunks) reject.
 */
export function post(
  port: number,
  path: string,
  body: unknown,
  token: string,
  timeoutMs = POST_TIMEOUT_MS,
): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          origin: `http://127.0.0.1:${port}`,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "ductus-protocol": "1",
          cookie: `__Host-ductus_session=${token}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("error", reject);
        // After "end" this is a no-op; before it, the body was cut.
        res.on("close", () => {
          if (!res.complete) reject(new Error(`${path}: the answer was cut before its end`));
        });
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(deadline);
          // Decoded once, so a character split across chunks stays whole.
          const data = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          try {
            resolve({ status, text: data, body: JSON.parse(data) as Answer["body"] });
          } catch {
            resolve({ status, text: data, body: {} });
          }
        });
      },
    );
    req.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    req.on("close", () => clearTimeout(deadline));
    const deadline = setTimeout(
      () => req.destroy(new Error(`${path}: no complete answer in ${timeoutMs} ms`)),
      timeoutMs,
    );
    req.end(text);
  });
}

type GoldenSegment = Record<string, unknown> & { events: Record<string, unknown>[] };

/** The commit request of one segment, from the invented golden segment. */
export function commitRequest(opened: Record<string, unknown>, transaction: string) {
  const { chain } = JSON.parse(
    readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
  ) as {
    chain: { segments: { segment: GoldenSegment }[]; documentStates: { value: unknown }[] };
  };
  const template = chain.segments[0]!.segment;
  const documentHash = opened.documentHash as string;
  const document = canonicalizeJcs(chain.documentStates[1]!.value);
  const segment = canonicalizeJcs({
    ...template,
    documentId: opened.documentId,
    sessionId: `sesija-${transaction}`,
    segmentId: `segment-${transaction}`,
    sequenceFrom: 1,
    sequenceTo: 1,
    initialDocumentHash: documentHash,
    finalDocumentHash: sha256(document),
    predecessorSegmentHash: null,
    evidenceProfileId: opened.evidenceProfileId,
    events: [
      {
        ...template.events[0],
        sequence: 1,
        beforeDocumentHash: documentHash,
        afterDocumentHash: sha256(document),
      },
    ],
  });
  return {
    documentId: opened.documentId,
    clientTransactionId: transaction,
    baseRevision: 0,
    segments: [Buffer.from(segment, "utf8").toString("base64")],
    document: Buffer.from(document, "utf8").toString("base64"),
  };
}
