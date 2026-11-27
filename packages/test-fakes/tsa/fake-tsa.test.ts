import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { beforeAll, describe, expect, it } from "vitest";

import { createFakeClock } from "../clock/index.ts";
import { createFakeTsa, createTestPki, FAKE_TSA_MODES, OID_SHA256, type TestPki } from "./index.ts";

const TSA_URL = "https://tsa.ductura.invalid/";

function request(
  options: { imprint?: Uint8Array; algorithm?: string; version?: number } = {},
): Uint8Array {
  const req = new pkijs.TimeStampReq({
    version: options.version ?? 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: options.algorithm ?? OID_SHA256,
      }),
      hashedMessage: new asn1js.OctetString({
        valueHex: (options.imprint ?? new Uint8Array(32)).slice().buffer,
      }),
    }),
    nonce: new asn1js.Integer({ value: 4242 }),
    certReq: true,
  });
  return new Uint8Array(req.toSchema().toBER(false));
}

function status(body: ArrayBuffer): number {
  const response = new pkijs.TimeStampResp({ schema: asn1js.fromBER(body).result });
  return response.status.status;
}

let pki: TestPki;
beforeAll(async () => {
  pki = await createTestPki(new Date("2026-11-27T03:00:00.000Z"));
});

describe("createTestPki", () => {
  it("makes a root, an intermediate under it and TSA certificates under the intermediate", async () => {
    const at = pki.now;
    const engine = new pkijs.CertificateChainValidationEngine({
      trustedCerts: [pki.root.certificate],
      certs: [pki.intermediate.certificate, pki.tsa.certificate],
      checkDate: at,
    });
    expect((await engine.verify()).result).toBe(true);
    expect(pki.expiredTsa.certificate.notAfter.value.getTime()).toBeLessThan(at.getTime());
    expect(pki.root.der).not.toEqual(pki.foreignRoot.der);
  });

  it("makes new keys on every call (nothing is fixed in the repository)", async () => {
    const other = await createTestPki(pki.now);
    expect(Buffer.from(other.root.der).equals(Buffer.from(pki.root.der))).toBe(false);
  });
});

describe("createFakeTsa", () => {
  it("refuses an unknown mode", async () => {
    await expect(createFakeTsa({ mode: "flaky" as never, pki })).rejects.toThrow(/mode/u);
  });

  const invalid: [string, Uint8Array][] = [
    ["an empty body", new Uint8Array()],
    ["bytes that are not DER", new Uint8Array([1, 2, 3])],
    ["a 31-byte imprint", request({ imprint: new Uint8Array(31) })],
    ["a 33-byte imprint", request({ imprint: new Uint8Array(33) })],
    ["a SHA-1 imprint", request({ algorithm: "1.3.14.3.2.26", imprint: new Uint8Array(32) })],
    ["version 2", request({ version: 2 })],
    ["trailing bytes", new Uint8Array([...request(), 0])],
  ];
  it.each(invalid)("records and refuses %s with PKIStatus rejection", async (_, body) => {
    const tsa = await createFakeTsa({ mode: "valid", pki });
    const response = await tsa.fetch(TSA_URL, { method: "POST", body: body.slice() });
    expect(response.status).toBe(200);
    expect(status(await response.arrayBuffer())).toBe(pkijs.PKIStatus.rejection);
    expect(tsa.requests).toHaveLength(1);
    expect(tsa.requests[0]?.valid).toBe(false);
    expect(Buffer.from(tsa.requests[0]?.der ?? [])).toEqual(Buffer.from(body));
  });

  it("records a valid request and answers granted with genTime from the clock", async () => {
    const clock = createFakeClock("2026-11-27T03:00:00.000Z");
    const tsa = await createFakeTsa({ mode: "valid", pki, clock });
    const response = await tsa.fetch(TSA_URL, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query" },
      body: request().slice(),
    });
    expect(response.headers.get("content-type")).toBe("application/timestamp-reply");
    expect(status(await response.arrayBuffer())).toBe(pkijs.PKIStatus.granted);
    expect(tsa.requests).toEqual([
      { der: request(), valid: true, contentType: "application/timestamp-query" },
    ]);
  });

  it("timeout never answers until the request is aborted", async () => {
    const tsa = await createFakeTsa({ mode: "timeout", pki });
    const controller = new AbortController();
    const pending = tsa.fetch(TSA_URL, {
      method: "POST",
      body: request().slice(),
      signal: controller.signal,
    });
    let settled = false;
    void pending.catch(() => {}).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an already aborted request rejects in every mode", async () => {
    for (const mode of FAKE_TSA_MODES) {
      const tsa = await createFakeTsa({ mode, pki });
      await expect(
        tsa.fetch(TSA_URL, {
          method: "POST",
          body: request().slice(),
          signal: AbortSignal.abort(),
        }),
      ).rejects.toBeDefined();
    }
  });
});
