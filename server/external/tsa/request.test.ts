import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, it } from "vitest";

import { buildTimeStampRequest, DIGEST_BYTES, newNonce, NONCE_BYTES } from "./index.ts";

const DIGEST = new Uint8Array(DIGEST_BYTES).map((_, i) => i + 1);

function parse(der: Uint8Array): pkijs.TimeStampReq {
  const asn = asn1js.fromBER(der);
  expect(asn.offset).toBe(der.byteLength);
  return new pkijs.TimeStampReq({ schema: asn.result });
}

describe("newNonce", () => {
  it("is 16 bytes, positive, with no leading zero, and new each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const nonce = newNonce();
      expect(nonce.byteLength).toBe(NONCE_BYTES);
      expect(nonce[0]).toBeGreaterThanOrEqual(0x40);
      expect(nonce[0]).toBeLessThanOrEqual(0x7f);
      seen.add(Buffer.from(nonce).toString("hex"));
    }
    expect(seen.size).toBe(500);
  });

  it("forces the first byte even when the source returns 0x00 or 0xff", () => {
    expect(newNonce((b) => b.fill(0))[0]).toBe(0x40);
    expect(newNonce((b) => b.fill(0xff))[0]).toBe(0x7f);
  });

  it("refuses a random source that returns the wrong length (programming error)", () => {
    expect(() => newNonce(() => new Uint8Array(4))).toThrow();
  });
});

describe("buildTimeStampRequest", () => {
  it("encodes v1, a SHA-256 imprint of exactly the digest, the nonce, certReq and no policy", () => {
    const nonce = newNonce();
    const result = buildTimeStampRequest(DIGEST, nonce);
    if (!result.ok) throw new Error(result.error.code);
    const request = parse(result.value);
    expect(request.version).toBe(1);
    expect(request.messageImprint.hashAlgorithm.algorithmId).toBe("2.16.840.1.101.3.4.2.1");
    expect(Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView)).toEqual(
      Buffer.from(DIGEST),
    );
    expect(Buffer.from(request.nonce?.valueBlock.valueHexView ?? [])).toEqual(Buffer.from(nonce));
    expect(request.certReq).toBe(true);
    expect(request.reqPolicy).toBeUndefined();
    expect(request.extensions).toBeUndefined();
  });

  it.each([0, 1, 20, 31, 33, 64])("refuses a digest of %i bytes", (length) => {
    const result = buildTimeStampRequest(new Uint8Array(length), newNonce());
    expect(result).toEqual({
      ok: false,
      error: { code: "TSA_DIGEST_INVALID", messageKey: "tsa.digest_invalid" },
    });
  });

  it("refuses a nonce that did not come from newNonce", () => {
    expect(() => buildTimeStampRequest(DIGEST, new Uint8Array(4).fill(1))).toThrow();
    expect(() => buildTimeStampRequest(DIGEST, new Uint8Array(16).fill(0x80))).toThrow();
    expect(() => buildTimeStampRequest(DIGEST, new Uint8Array(16))).toThrow();
  });

  it("encodes only the 32 bytes of a pooled Buffer digest and nonce, never the pool behind them", () => {
    // Buffer.from(…) of a short value is a view into Node's shared 8 KiB pool,
    // and Buffer#slice is a view too (Codex review on #912).
    const digest = Buffer.from(Buffer.from(DIGEST).toString("hex"), "hex");
    const nonce = Buffer.from(Buffer.from(newNonce()).toString("hex"), "hex");
    expect(digest.buffer.byteLength).toBeGreaterThan(DIGEST_BYTES);
    const result = buildTimeStampRequest(digest, nonce);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.byteLength).toBeLessThan(100);
    const request = parse(result.value);
    expect(Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView)).toEqual(
      digest,
    );
    expect(Buffer.from(request.nonce?.valueBlock.valueHexView ?? [])).toEqual(nonce);
  });
});
