// SRV-1807 acceptance: the link to the package and to the confirmation for the
// registrar is valid 24 hours, is the owner's session's only, and hands out the
// checked bytes; the confirmation holds no text of the work. Over the real
// reader and builder with a fake database that answers as
// app.read_submission_receipt does. Every token, id and text is invented
// (test-support/portable-record).
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAYLOAD,
  sourceOf,
  SUBMISSION_ID,
  TEXT,
  unzipStored,
} from "../../../test-support/portable-record/index.ts";
import { receiptPdfHr } from "../../../locales/index.ts";
import type { ActorTransaction, MySubmissionStateReader, WithActor } from "../../database/index.ts";
import { createPortableRecordReader } from "../../database/index.ts";
import { renderReceiptPdf, verifyPortableRecord } from "../../downloads/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import {
  createSubmissionConfirmationCode,
  type SubmissionConfirmationCode,
} from "../submission-confirmation-code.ts";

import {
  createSubmissionPackageRoutes,
  type SubmissionPackageRouteDeps,
} from "./submission-package.ts";

const ORIGIN = "https://demo-fakultet.invalid";
/** An invented confirmation code bound to the receipt (Dizajn 1.1). */
const CODE = "DK7M-4Q9P-X2HT-R8VN";
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const cookie = (token: string) => ({ cookie: `__Host-ductus_session=${token}` });
const LINK = (id: string) => `/api/v1/student/submissions/${id}/package-link`;

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

/** student.receipt-pdf.get's two reads for student A: the bound code and the live receipt. */
async function fakeCode(live = SUBMISSION_ID): Promise<SubmissionConfirmationCode> {
  const source = await sourceOf({ ...PAYLOAD, submissionId: live });
  const codes = {
    read: async (token: string | undefined) =>
      token === TOKEN_A
        ? ({ ok: true, value: CODE } as const)
        : ({ ok: false, error: { code: "MY_SUBMISSION_STATE_NOT_FOUND" } } as never),
  };
  const states = {
    state: async () => ({
      ok: true,
      value: {
        state: "potvrdeno",
        revision: PAYLOAD.revision,
        receiptPayload: source.receiptPayload,
        payloadDigestSha256: source.payloadDigestSha256,
        signature: source.signature,
      },
    }),
  } as unknown as MySubmissionStateReader;
  return createSubmissionConfirmationCode(codes, states);
}

let running: Running | undefined;
let clock = Date.parse("2026-11-21T10:00:00.000Z");

async function start(over: Partial<SubmissionPackageRouteDeps> = {}): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createSubmissionPackageRoutes({
      read: createPortableRecordReader(await fakeDatabase()),
      dailyRoot: async () => ({ status: "pending" }),
      origin: ORIGIN,
      code: await fakeCode(),
      now: () => clock,
      ...over,
    }),
  });
  return `http://127.0.0.1:${running.port}`;
}

afterEach(async () => {
  clock = Date.parse("2026-11-21T10:00:00.000Z");
  await running?.close();
  running = undefined;
});

const noDailyRoot = async () => ({ ok: false }) as const;
const post = (host: string, id: string, token: string, body: unknown) =>
  fetch(host + LINK(id), {
    method: "POST",
    headers: {
      ...cookie(token),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
const get = (host: string, path: string, token: string) =>
  fetch(host + path, { headers: cookie(token) });

type Link = { kind: string; downloadPath: string; expiresAt: string };

describe("student.submission-package-link.post and student.submission-package.get", () => {
  it("gives the owner a package link that holds for 24 hours and then answers 410", async () => {
    const host = await start();
    const asked = await post(host, SUBMISSION_ID, TOKEN_A, { kind: "package" });
    expect(asked.status).toBe(201);
    expect(asked.headers.get("cache-control")).toBe("no-store");
    const link = (await asked.json()) as Link;
    expect(link.kind).toBe("package");
    expect(link.expiresAt).toBe("2026-11-22T10:00:00.000Z");
    expect(link.downloadPath).toMatch(
      new RegExp(`^/api/v1/student/submissions/${SUBMISSION_ID}/package/package\\?token=`, "u"),
    );

    clock += 24 * 60 * 60 * 1000 - 1;
    const first = await get(host, link.downloadPath, TOKEN_A);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/zip");
    expect(first.headers.get("content-disposition")).toBe(
      'attachment; filename="prenosivi-zapis.zip"',
    );
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(first.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const files = unzipStored(bytes);
    expect(Buffer.from(files.get("rad.json")!).toString("utf8")).toBe(TEXT);
    // Acceptance 1: the manifest is checked offline, as scripts/evidence-verify --record does.
    expect(await verifyPortableRecord(files, noDailyRoot)).toMatchObject({
      ok: true,
      submissionId: SUBMISSION_ID,
    });
    // The same link again gives the same bytes.
    const again = await get(host, link.downloadPath, TOKEN_A);
    expect(Buffer.from(await again.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);

    clock += 1;
    const late = await get(host, link.downloadPath, TOKEN_A);
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ code: "not_allowed" });
  });

  it("gives the confirmation for the registrar as a PDF without the text of the work", async () => {
    const host = await start();
    const link = (await (
      await post(host, SUBMISSION_ID, TOKEN_A, { kind: "referada" })
    ).json()) as Link;
    const response = await get(host, link.downloadPath, TOKEN_A);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="potvrda-za-referadu.pdf"',
    );
    const pdf = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("x-content-sha256")).toBe(
      createHash("sha256").update(pdf).digest("hex"),
    );
    expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Buffer.from(pdf).toString("latin1")).not.toContain("composting");
    // Dizajn 1.1: the receipt route's PDF, the QR of /provjera#k={code} and the code.
    const source = await sourceOf();
    const receipt = {
      payload: JSON.parse(source.receiptPayload),
      payloadDigestSha256: source.payloadDigestSha256,
      signature: source.signature,
    } as Parameters<typeof renderReceiptPdf>[0];
    const routePdf = Buffer.from(await renderReceiptPdf(receipt, ORIGIN, receiptPdfHr, CODE));
    expect(Buffer.from(pdf).equals(routePdf)).toBe(true);
    expect(
      routePdf.equals(Buffer.from(await renderReceiptPdf(receipt, ORIGIN, receiptPdfHr))),
    ).toBe(false);
  });

  it("answers the other student, an unknown and a malformed id with the same 404", async () => {
    const host = await start();
    const answers = await Promise.all([
      post(host, SUBMISSION_ID, TOKEN_B, { kind: "package" }),
      post(host, "00000000-0000-4000-8000-000000000009", TOKEN_A, { kind: "package" }),
      post(host, "nije-uuid", TOKEN_A, { kind: "package" }),
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

  it("does not hand a link to another session, submission or kind", async () => {
    const host = await start();
    const link = (await (
      await post(host, SUBMISSION_ID, TOKEN_A, { kind: "package" })
    ).json()) as Link;
    const token = new URL(link.downloadPath, host).searchParams.get("token")!;
    const base = `/api/v1/student/submissions/${SUBMISSION_ID}/package`;
    const paths = [
      [`${base}/package?token=${token}`, TOKEN_B],
      [`${base}/referada?token=${token}`, TOKEN_A],
      [
        `/api/v1/student/submissions/00000000-0000-4000-8000-000000000009/package/package?token=${token}`,
        TOKEN_A,
      ],
      [`${base}/package`, TOKEN_A],
      [`${base}/package?token=${token}x`, TOKEN_A],
      [`${base}/zip?token=${token}`, TOKEN_A],
    ] as const;
    for (const [path, session] of paths) {
      const answer = await get(host, path, session);
      expect(answer.status).toBe(404);
    }
  });

  it.each([
    [{}, 401],
    [{ "sec-fetch-site": "cross-site" }, 403],
  ] as const)("refuses a download before reading (%o)", async (extra, status) => {
    const read = vi.fn<SubmissionPackageRouteDeps["read"]>();
    const host = await start({ read });
    const headers = status === 401 ? extra : { ...cookie(TOKEN_A), ...extra };
    const response = await fetch(
      `${host}/api/v1/student/submissions/${SUBMISSION_ID}/package/package?token=1.${"A".repeat(43)}`,
      { headers },
    );
    expect(response.status).toBe(status);
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a link request with no session, no JSON or an unknown kind", async () => {
    const read = vi.fn<SubmissionPackageRouteDeps["read"]>();
    const host = await start({ read });
    const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin" };
    const url = host + LINK(SUBMISSION_ID);
    const noSession = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "package" }),
    });
    expect(noSession.status).toBe(401);
    const text = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...cookie(TOKEN_A), "content-type": "text/plain" },
      body: "x",
    });
    expect(text.status).toBe(415);
    const bad = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...cookie(TOKEN_A), "content-type": "application/json" },
      body: "{",
    });
    expect(bad.status).toBe(400);
    for (const body of [{ kind: "zip" }, { kind: "package", extra: 1 }, {}]) {
      expect((await post(host, SUBMISSION_ID, TOKEN_A, body)).status).toBe(422);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("is 503 without an origin, for a record it cannot vouch for and on a throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cases: Partial<SubmissionPackageRouteDeps>[] = [
        { origin: null },
        { read: createPortableRecordReader(await fakeDatabase(TEXT.replace("waste", "wastE"))) },
        { read: async () => ({ status: "unavailable", reason: "key_malformed" }) },
        { read: async () => Promise.reject(new Error("database down")) },
        { dailyRoot: async () => ({ status: "unavailable" }) },
        // The live submission of the assignment is another one: no PDF without its code.
        { code: await fakeCode("00000000-0000-4000-8000-000000000009") },
      ];
      for (const over of cases) {
        const host = await start({ read: createPortableRecordReader(await fakeDatabase()) });
        const link = (await (
          await post(host, SUBMISSION_ID, TOKEN_A, { kind: "package" })
        ).json()) as Link;
        await running?.close();
        const broken = await start(over);
        const response = await get(broken, link.downloadPath, TOKEN_A);
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
