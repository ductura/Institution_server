// The requests of a signed-in student's browser to the stack's server, shared
// by the commit check (DAN-817) and the functional tests (tests/functional,
// DAN-1003). Moved unchanged from vs1-commit-check.ts. Every value is invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeJcs } from "../../server/domain/index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export type Answer = { status: number; body: Record<string, unknown> };

/** One POST as the browser of a signed-in student sends it. */
export function post(port: number, path: string, body: unknown, token: string): Promise<Answer> {
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
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Answer["body"] });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on("error", reject);
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
