// SRV-1903 routes on a real server with the real pipeline, over a fake port
// and a real Ed25519 signer made for the test: the success and refusal
// vectors of the contract, the mapping of every refusal of the database, the
// 404 of a malformed id before the port, the receipt signed as the submission
// receipt (schema name, newline, SHA-256 of the text) and 503 for a stored
// receipt that is not what the withdrawal names. The framing vectors belong
// to the shared layers. All values are invented.
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { SubmissionWithdrawals } from "../../database/index.ts";
import type { SigningKeyProvider } from "../../external/keys/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createSubmissionWithdrawalRoutes } from "./index.ts";
import { WITHDRAWAL_RECEIPT_KEYS, withdrawalSigningInput } from "./withdrawal-receipt.ts";

type Vector = {
  name: string;
  code?: string;
  request: {
    params: Record<string, string>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const FRAMING = new Set([
  "origin_missing",
  "origin_mismatch",
  "cross_site",
  "body_too_large",
  "body_timeout",
  "content_length_invalid",
  "content_length_mismatch",
  "body_stream_error",
  "unsupported_media_type",
  "invalid_json",
]);
const WITHDRAW = vectorsOf("student.submission-withdrawal.post").filter(
  (v) => !FRAMING.has(v.code ?? ""),
);
const MY_HISTORY = vectorsOf("student.submission-history.get");
const STATE = vectorsOf("student.submission-withdrawal.get");
const THEIR_HISTORY = vectorsOf("teacher.submission-history.get");
const SETTING_GET = vectorsOf("teacher.submission-withdrawal.get");
const SETTING_POST = vectorsOf("teacher.submission-withdrawal.post").filter(
  (v) => !FRAMING.has(v.code ?? ""),
);
const ORIGIN = "https://ductura.example.invalid";
const A = "00000000-0000-4000-8000-0000000000a1";
const COOKIE = "__Host-ductus_session=izmisljeni-token-00000000000000000000000000";
const POST_HEADERS = { cookie: COOKIE, origin: ORIGIN, "sec-fetch-site": "same-origin" };

type Receipt = {
  payload: Record<string, unknown>;
  payloadDigestSha256: string;
  signature: unknown;
};
const WITHDRAWN = WITHDRAW.find((v) => v.name === "withdrawn")!.response.body.receipt as Receipt;
/** The canonical text of a withdrawal payload: keys in UTF-16 order, no spaces. */
const textOf = (payload: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(WITHDRAWAL_RECEIPT_KEYS.map((key) => [key, payload[key]])));

// A real key, made for this test only.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY = { keyId: "izmisljeni-kljuc-testa", keyVersion: "1" };
const signed: Uint8Array[] = [];
const SIGNER: SigningKeyProvider = {
  async sign(message) {
    signed.push(message);
    return {
      ok: true,
      value: {
        algorithm: "Ed25519",
        ...KEY,
        signatureEncoding: "raw",
        signatureBase64Url: edSign(null, message, privateKey).toString("base64url"),
      },
    };
  },
  async verify(message, signature) {
    return {
      ok: true,
      value: edVerify(
        null,
        message,
        publicKey,
        Buffer.from(signature.signatureBase64Url, "base64url"),
      ),
    };
  },
  async publicVerificationKey() {
    return {
      ok: true,
      value: {
        algorithm: "Ed25519",
        ...KEY,
        encoding: "spki-der",
        keyBase64Url: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      },
    };
  },
};

let running: Running | undefined;
/** The process clock of the state route: an hour before the history vector's deadline. */
let clockAt = "2026-12-20T21:59:00.000Z";
const calls: unknown[][] = [];
const port: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
const reply = (name: string, answer: (...args: unknown[]) => unknown) => {
  port[name] = async (...args: unknown[]) => {
    calls.push([name, ...args]);
    return answer(...args);
  };
};
function reset() {
  for (const name of [
    "withdraw",
    "attach",
    "studentHistory",
    "teacherHistory",
    "setting",
    "setSetting",
  ])
    reply(name, () => ({ status: "not_found" }));
}
reset();

async function start(): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createSubmissionWithdrawalRoutes(
      port as unknown as SubmissionWithdrawals,
      SIGNER,
      () => new Date(clockAt),
    ),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  signed.length = 0;
  reset();
  await running?.close();
  running = undefined;
});

async function expectAnswer(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  const body = (await got.json()) as Record<string, unknown>;
  if (v.response.status < 300) expect(body).toEqual(v.response.body);
  else expect(body).toEqual({ ...v.response.body, requestId: got.headers.get("x-request-id") });
}

/** The wire code of each refusal of the database, as pairs (codes are snake_case). */
const REFUSAL_OF = new Map([
  ["not_found", "not_found"],
  ["not_allowed", "disabled"],
  ["refused", "after_deadline"],
  ["not_started", "none"],
  ["conflict", "pending"],
]);

describe("student.submission-withdrawal.post", () => {
  const withdraw = (base: string, headers: Record<string, string> = POST_HEADERS, id = A) =>
    fetch(`${base}/student/assignments/${id}/submission/withdrawal`, { method: "POST", headers });

  it.each(WITHDRAW.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    reply("withdraw", () => {
      if (v.response.status === 200)
        return {
          status: "existing",
          withdrawalId: WITHDRAWN.payload.withdrawalId,
          receiptPayload: textOf(WITHDRAWN.payload),
          payloadDigestSha256: WITHDRAWN.payloadDigestSha256,
          signature: WITHDRAWN.signature,
        };
      if (v.response.status === 503) throw new Error("izmisljena greska");
      return { status: REFUSAL_OF.get(v.code ?? "") ?? "unauthorized" };
    });
    const base = await start();
    await expectAnswer(await withdraw(base, v.request.headers ?? {}), v);
  });

  it("signs a new withdrawal as the submission receipt and returns what the database bound", async () => {
    const text = textOf(WITHDRAWN.payload);
    reply("withdraw", () => ({
      status: "withdrawn",
      withdrawalId: WITHDRAWN.payload.withdrawalId,
      receiptPayload: text,
      payloadDigestSha256: WITHDRAWN.payloadDigestSha256,
      signature: null,
    }));
    reply("attach", (_token, _id, digest, signature) => ({
      status: "attached",
      receiptPayload: text,
      payloadDigestSha256: digest,
      signature,
    }));
    const base = await start();
    const got = await withdraw(base);
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      status: string;
      receipt: Receipt & { signature: { signatureBase64Url: string } };
    };
    expect(body.status).toBe("withdrawn");
    expect(body.receipt.payload).toEqual(WITHDRAWN.payload);
    // The key named by the signer froze the receipt; the signed bytes are the
    // schema name, a newline and the SHA-256 of the frozen text.
    expect(calls[0]).toEqual(["withdraw", "izmisljeni-token-00000000000000000000000000", A, KEY]);
    expect(signed).toEqual([withdrawalSigningInput(text)]);
    const input = Buffer.from(withdrawalSigningInput(text));
    expect(input.subarray(0, 40).toString("utf8")).toBe(
      "ductus-submission-withdrawal-receipt-v1\n",
    );
    expect(input.subarray(40).toString("hex")).toBe(WITHDRAWN.payloadDigestSha256);
    expect(
      edVerify(
        null,
        input,
        publicKey,
        Buffer.from(body.receipt.signature.signatureBase64Url, "base64url"),
      ),
    ).toBe(true);
  });

  it("a frozen text that is not the withdrawal's own is never signed: 503", async () => {
    for (const receiptPayload of [
      textOf({ ...WITHDRAWN.payload, withdrawalId: "00000000-0000-4000-8000-0000000000ff" }),
      JSON.stringify(WITHDRAWN.payload),
      textOf(WITHDRAWN.payload) + " ",
    ]) {
      reply("withdraw", () => ({
        status: "withdrawn",
        withdrawalId: WITHDRAWN.payload.withdrawalId,
        receiptPayload,
        payloadDigestSha256: WITHDRAWN.payloadDigestSha256,
        signature: null,
      }));
      const base = await start();
      expect((await withdraw(base)).status).toBe(503);
      await running?.close();
      running = undefined;
    }
    expect(signed).toEqual([]);
  });

  it("a key the database refuses or a refused bind is 503", async () => {
    reply("withdraw", () => ({ status: "key_unavailable" }));
    let base = await start();
    expect((await withdraw(base)).status).toBe(503);
    await running?.close();
    reply("withdraw", () => ({
      status: "withdrawn",
      withdrawalId: WITHDRAWN.payload.withdrawalId,
      receiptPayload: textOf(WITHDRAWN.payload),
      payloadDigestSha256: WITHDRAWN.payloadDigestSha256,
      signature: null,
    }));
    reply("attach", () => ({ status: "key_mismatch" }));
    base = await start();
    expect((await withdraw(base)).status).toBe(503);
  });

  it("without the signer's key the database still answers its refusals first", async () => {
    const key = SIGNER.publicVerificationKey;
    SIGNER.publicVerificationKey = async () =>
      ({ ok: false, error: { code: "kms_unavailable" } }) as never;
    try {
      reply("withdraw", () => ({ status: "not_found" }));
      const base = await start();
      expect((await withdraw(base)).status).toBe(404);
      expect(calls[0]?.[3]).toEqual({ keyId: "no-signing-key", keyVersion: "0" });
    } finally {
      SIGNER.publicVerificationKey = key;
    }
  });

  it("a malformed assignment id is 404 before the port", async () => {
    const base = await start();
    const got = await withdraw(base, POST_HEADERS, "ne-postoji");
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

/** A wire event back as the port's row: the receipt as the database's text. */
function portEvent(event: Record<string, unknown>) {
  const receipt = event.receipt as Receipt | null;
  return {
    kind: event.kind,
    id: event.id,
    attempt: event.attempt,
    submissionId: event.submissionId,
    revision: event.revision,
    at: event.at,
    afterDeadline: event.kind === "submission" ? event.afterDeadline : null,
    receiptPayload:
      receipt === null
        ? null
        : event.kind === "withdrawal"
          ? textOf(receipt.payload)
          : JSON.stringify(receipt.payload),
    payloadDigestSha256: receipt?.payloadDigestSha256 ?? null,
    signature: receipt?.signature ?? null,
  };
}

describe("the histories", () => {
  it.each(MY_HISTORY.map((v) => [v.name, v] as const))("student vector %s", async (_name, v) => {
    reply("studentHistory", () => {
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.response.status !== 200) return { status: v.code };
      const body = v.response.body;
      return {
        status: "read",
        withdrawalAllowed: body.withdrawalAllowed,
        dueAt: body.dueAt,
        events: (body.events as Record<string, unknown>[]).map(portEvent),
      };
    });
    const base = await start();
    const got = await fetch(
      `${base}/student/assignments/${v.request.params.assignmentId}/submission/history`,
      { headers: v.request.headers ?? {} },
    );
    await expectAnswer(got, v);
  });

  it.each(THEIR_HISTORY.map((v) => [v.name, v] as const))("teacher vector %s", async (_name, v) => {
    reply("teacherHistory", () => {
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.response.status !== 200) return { status: v.code };
      return {
        status: "read",
        events: (v.response.body.events as Record<string, unknown>[]).map(portEvent),
      };
    });
    const base = await start();
    const { assignmentId, studentId } = v.request.params;
    const got = await fetch(
      `${base}/teacher/assignments/${assignmentId}/students/${studentId}/submission-history`,
      { headers: v.request.headers ?? {} },
    );
    await expectAnswer(got, v);
  });

  const stateOf = (v: Vector, patch: { allowed?: boolean; take?: number } = {}) => {
    reply("studentHistory", () => {
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.response.status !== 200) return { status: v.code };
      const events = (MY_HISTORY[0]!.response.body.events as Record<string, unknown>[]).map(
        portEvent,
      );
      return {
        status: "read",
        withdrawalAllowed: patch.allowed ?? true,
        dueAt: MY_HISTORY[0]!.response.body.dueAt,
        events: events.slice(0, patch.take ?? (v.response.body?.withdrawable ? 1 : 2)),
      };
    });
  };
  const readState = async (assignmentId: string, headers: Record<string, string>) =>
    fetch(`${await start()}/student/assignments/${assignmentId}/submission/withdrawal`, {
      headers,
    });

  it.each(STATE.map((v) => [v.name, v] as const))("withdrawal state vector %s", async (_n, v) => {
    stateOf(v);
    await expectAnswer(
      await readState(v.request.params.assignmentId ?? A, v.request.headers ?? {}),
      v,
    );
  });

  it("is not withdrawable when the teacher switched it off, after the deadline, or while the last receipt is unbound", async () => {
    const open = STATE.find((v) => v.name === "withdrawable")!;
    const ask = async () =>
      (await (await readState(A, { cookie: COOKIE })).json()) as { withdrawable: boolean };
    stateOf(open, { allowed: false });
    expect((await ask()).withdrawable).toBe(false);
    stateOf(open);
    expect((await ask()).withdrawable).toBe(true);
    clockAt = "2026-12-20T23:00:00.000Z";
    expect((await ask()).withdrawable).toBe(false);
    clockAt = "2026-12-20T21:59:00.000Z";
    // Events 1..3: the history vector ends in a submission whose receipt is not bound yet.
    stateOf(open, { take: 3 });
    expect((await ask()).withdrawable).toBe(false);
  });

  it("a malformed assignment id is 404 before the port for the state route", async () => {
    const got = await readState("ne-postoji", { cookie: COOKIE });
    expect(got.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("a bound withdrawal receipt that does not match its text is 503, never a partial list", async () => {
    const events = (MY_HISTORY[0]!.response.body.events as Record<string, unknown>[]).map(
      portEvent,
    );
    events[1] = { ...events[1]!, payloadDigestSha256: "0".repeat(64) };
    reply("teacherHistory", () => ({ status: "read", events }));
    const base = await start();
    const got = await fetch(`${base}/teacher/assignments/${A}/students/${A}/submission-history`, {
      headers: { cookie: COOKIE },
    });
    expect(got.status).toBe(503);
  });
});

describe("the teacher's switch", () => {
  it.each(SETTING_GET.map((v) => [v.name, v] as const))("GET vector %s", async (_name, v) => {
    reply("setting", () => {
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.response.status !== 200) return { status: v.code };
      return { status: "read", ...v.response.body };
    });
    const base = await start();
    const got = await fetch(`${base}/teacher/assignments/${A}/submission-withdrawal`, {
      headers: v.request.headers ?? {},
    });
    await expectAnswer(got, v);
  });

  it.each(SETTING_POST.map((v) => [v.name, v] as const))("POST vector %s", async (_name, v) => {
    reply("setSetting", () => {
      if (v.response.status === 503) throw new Error("izmisljena greska");
      if (v.response.status !== 200) return { status: v.code };
      return { status: "read", ...v.response.body };
    });
    const base = await start();
    const got = await fetch(`${base}/teacher/assignments/${A}/submission-withdrawal`, {
      method: "POST",
      headers: v.request.headers ?? {},
      body: v.request.rawBody ?? JSON.stringify(v.request.body ?? {}),
    });
    await expectAnswer(got, v);
  });
});
