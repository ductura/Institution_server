// SRV-1312 acceptance 4: the route gives the ZIP only to the student who
// submitted, over the real reader and builder with a fake database that
// answers as app.read_submission_receipt does. Two invented students: the
// other one, an unknown and a malformed id get the same 404 (C-23). Every
// token, id and text is invented (test-support/portable-record).
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAYLOAD,
  sourceOf,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createPortableRecordReader } from "../../database/index.ts";
import { verifyPortableRecord } from "../../downloads/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createPortableRecordRoute, type PortableRecordRouteDeps } from "./index.ts";

const ORIGIN = "https://demo-fakultet.invalid";
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const cookie = (token: string) => ({ cookie: `__Host-ductus_session=${token}` });
const PATH = (id: string) => `/api/v1/student/submissions/${id}/portable-record`;

type Row = Record<string, unknown>;

/** The three reads as the database answers them: only student A owns the submission. */
async function fakeDatabase(text = TEXT): Promise<WithActor> {
  const source = await sourceOf(PAYLOAD, text);
  const key = source.key as Record<string, unknown>;
  return (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(sql, values) {
        let rows: Row[];
        if (sql.includes("app.read_submission_receipt")) {
          rows = [
            token === TOKEN_A && values?.[0] === SUBMISSION_ID
              ? {
                  outcome: "found",
                  payload: source.receiptPayload,
                  digest: source.payloadDigestSha256,
                  signature: source.signature,
                }
              : { outcome: "not_found" },
          ];
        } else if (sql.includes("app.read_work_export")) {
          rows = [{ outcome: "found", revision: String(PAYLOAD.revision), body: text }];
        } else {
          rows = [
            {
              outcome: "match",
              keyBase64Url: key.keyBase64Url,
              domain: key.evidenceDomainId,
              purpose: key.purpose,
              validFrom: key.validFrom,
              validTo: null,
              revokedAt: null,
            },
          ];
        }
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
}

let running: Running | undefined;

async function start(over: Partial<PortableRecordRouteDeps> = {}): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [
      createPortableRecordRoute({
        read: createPortableRecordReader(await fakeDatabase()),
        dailyRoot: async () => ({ status: "pending" }),
        origin: ORIGIN,
        ...over,
      }),
    ],
  });
  return `http://127.0.0.1:${running.port}`;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
});

const noDailyRoot = async () => ({ ok: false }) as const;

describe("student.portable-record.get", () => {
  it("gives the owner the same verifiable ZIP every time", async () => {
    const host = await start();
    const first = await fetch(host + PATH(SUBMISSION_ID), { headers: cookie(TOKEN_A) });
    const second = await fetch(host + PATH(SUBMISSION_ID.toUpperCase()), {
      headers: cookie(TOKEN_A),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/zip");
    expect(first.headers.get("content-disposition")).toBe(
      'attachment; filename="prenosivi-zapis.zip"',
    );
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.has("set-cookie")).toBe(false);
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(Buffer.from(await second.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(first.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const files = unzipStored(bytes);
    expect(Buffer.from(files.get("rad.json")!).toString("utf8")).toBe(TEXT);
    expect(await verifyPortableRecord(files, noDailyRoot)).toMatchObject({
      ok: true,
      submissionId: SUBMISSION_ID,
      dailyRoot: null,
    });
  });

  it("answers the other student, an unknown and a malformed id with the same 404", async () => {
    const host = await start();
    const answers = await Promise.all([
      fetch(host + PATH(SUBMISSION_ID), { headers: cookie(TOKEN_B) }),
      fetch(host + PATH("00000000-0000-4000-8000-000000000009"), { headers: cookie(TOKEN_A) }),
      fetch(host + PATH("nije-uuid"), { headers: cookie(TOKEN_A) }),
    ]);
    const bodies = await Promise.all(
      answers.map(async (answer) => {
        expect(answer.status).toBe(404);
        const { requestId: unused, ...body } = (await answer.json()) as Record<string, unknown>;
        void unused;
        return body;
      }),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]).toMatchObject({ code: "not_found" });
  });

  it.each([
    [{}, 401],
    [{ ...cookie(TOKEN_A), "sec-fetch-site": "cross-site" }, 403],
  ] as const)("refuses before reading (%o)", async (headers, status) => {
    const read = vi.fn<PortableRecordRouteDeps["read"]>();
    const response = await fetch((await start({ read })) + PATH(SUBMISSION_ID), { headers });
    expect(response.status).toBe(status);
    expect(read).not.toHaveBeenCalled();
  });

  it("is 503 without an origin, for a record it cannot vouch for and on a throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cases: Partial<PortableRecordRouteDeps>[] = [
        { origin: null },
        { read: createPortableRecordReader(await fakeDatabase(TEXT.replace("waste", "wastE"))) },
        { read: async () => ({ status: "unavailable", reason: "key_malformed" }) },
        { read: async () => Promise.reject(new Error("database down")) },
        { dailyRoot: async () => ({ status: "unavailable" }) },
      ];
      for (const over of cases) {
        const response = await fetch((await start(over)) + PATH(SUBMISSION_ID), {
          headers: cookie(TOKEN_A),
        });
        expect(response.status).toBe(503);
        await running?.close();
        running = undefined;
      }
      const lines = error.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('"reason":"text_mismatch"'))).toBe(true);
      expect(lines.join("\n")).not.toContain(SUBMISSION_ID);
    } finally {
      error.mockRestore();
    }
  });
});
