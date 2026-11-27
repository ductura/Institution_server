import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { createFakeClock, type FakeClock } from "../clock/index.ts";
import { createTestPki, type TestCertificate, type TestPki } from "./pki.ts";

// The fake RFC 3161 time-stamping authority (ISTR-2 step 2): a `fetch` with no
// port. One mode per golden case of the plan (docs/plan/ISTR-2-TSA.md §4 step
// 2) plus three that reach the remaining checks of the port:
// - valid: a correct response signed by `pki.tsa`;
// - rejection: PKIStatus rejection, no token;
// - wrong-imprint: the token carries a hash that differs in one byte;
// - wrong-nonce: the token carries a nonce that differs in one byte;
// - expired-certificate: signed by a TSA certificate that expired before genTime;
// - wrong-eku: signed by a certificate whose only EKU is codeSigning;
// - malformed-der: 200 with bytes that are not DER;
// - timeout: never answers; only an abort of the request ends it;
// - untrusted-root: a valid token from a TSA under a root nobody trusts;
// - wrong-ess-cert-id: ESSCertIDv2 names a different certificate;
// - stale-gen-time: genTime one day before the request.
// Whatever the mode, a body that is not a TimeStampReq with a 32-byte SHA-256
// imprint is refused with PKIStatus rejection (badDataFormat) and recorded
// with `valid: false`.
export const FAKE_TSA_MODES = [
  "valid",
  "rejection",
  "wrong-imprint",
  "wrong-nonce",
  "expired-certificate",
  "wrong-eku",
  "malformed-der",
  "timeout",
  "untrusted-root",
  "wrong-ess-cert-id",
  "stale-gen-time",
] as const;

export type FakeTsaMode = (typeof FAKE_TSA_MODES)[number];

export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
export const OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
/** The example arc of X.660 (2.999): a policy no real TSA uses. */
export const FAKE_TSA_POLICY = "2.999.1";
const TIME_STAMP_REPLY = "application/timestamp-reply";
const DAY_MS = 24 * 60 * 60 * 1000;
/** PKIFailureInfo badDataFormat is bit 5. */
const BAD_DATA_FORMAT_BITS = 0b0000_0100;

export type FakeTsaRequest = {
  /** The body exactly as received. */
  readonly der: Uint8Array;
  /** True only for a DER TimeStampReq v1 with a 32-byte SHA-256 imprint. */
  readonly valid: boolean;
  readonly contentType: string | null;
};

export type FakeTsaOptions = {
  readonly mode: FakeTsaMode;
  /** The PKI that signs; default a new one around the clock's time. */
  readonly pki?: TestPki;
  /** genTime comes from this clock; default a new fake clock. */
  readonly clock?: FakeClock;
};

export type FakeTsa = {
  readonly mode: FakeTsaMode;
  readonly pki: TestPki;
  readonly clock: FakeClock;
  /** Every request seen, in order. */
  readonly requests: readonly FakeTsaRequest[];
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type ParsedRequest = { readonly request: pkijs.TimeStampReq; readonly imprint: Uint8Array };

function parseRequest(der: Uint8Array): ParsedRequest | null {
  if (der.byteLength === 0) return null;
  const asn = asn1js.fromBER(der);
  if (asn.offset === -1 || asn.offset !== der.byteLength) return null;
  let request: pkijs.TimeStampReq;
  try {
    request = new pkijs.TimeStampReq({ schema: asn.result });
  } catch {
    return null;
  }
  if (request.version !== 1) return null;
  if (request.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) return null;
  const imprint = new Uint8Array(request.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (imprint.byteLength !== 32) return null;
  return { request, imprint };
}

function flipLastByte(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0x01;
  return copy;
}

function statusOnly(status: pkijs.PKIStatus, failInfo?: number): Uint8Array {
  const response = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({
      status,
      ...(failInfo === undefined
        ? {}
        : {
            failInfo: new asn1js.BitString({
              valueHex: new Uint8Array([failInfo]).buffer,
              unusedBits: 2,
            }),
          }),
    }),
  });
  return new Uint8Array(response.toSchema().toBER(false));
}

/** SigningCertificateV2 with one ESSCertIDv2 (SHA-256, the default, so no algorithm field). */
async function signingCertificateV2(certificateDer: Uint8Array): Promise<asn1js.Sequence> {
  const hash = await crypto.subtle.digest("SHA-256", certificateDer);
  return new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: hash })] })],
      }),
    ],
  });
}

async function grantedResponse(
  parsed: ParsedRequest,
  signer: TestCertificate,
  chain: readonly TestCertificate[],
  options: {
    imprint: Uint8Array;
    nonce: asn1js.Integer | undefined;
    genTime: Date;
    essFor: Uint8Array;
  },
): Promise<Uint8Array> {
  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: FAKE_TSA_POLICY,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(options.imprint).buffer }),
    }),
    serialNumber: new asn1js.Integer({
      valueHex: crypto.getRandomValues(new Uint8Array(8)).buffer,
    }),
    genTime: options.genTime,
    ...(options.nonce ? { nonce: options.nonce } : {}),
  });
  const eContent = tstInfo.toSchema().toBER(false);
  const digest = await crypto.subtle.digest("SHA-256", eContent);
  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new asn1js.OctetString({ valueHex: eContent }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: signer.certificate.issuer,
          serialNumber: signer.certificate.serialNumber,
        }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({
              type: OID_CONTENT_TYPE,
              values: [new asn1js.ObjectIdentifier({ value: OID_TST_INFO })],
            }),
            new pkijs.Attribute({
              type: OID_MESSAGE_DIGEST,
              values: [new asn1js.OctetString({ valueHex: digest })],
            }),
            new pkijs.Attribute({
              type: OID_SIGNING_CERTIFICATE_V2,
              values: [await signingCertificateV2(options.essFor)],
            }),
          ],
        }),
      }),
    ],
    ...(parsed.request.certReq
      ? { certificates: [signer, ...chain].map((c) => c.certificate) }
      : {}),
  });
  await signedData.sign(signer.keys.privateKey, 0, "SHA-256");
  const response = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: pkijs.PKIStatus.granted }),
    timeStampToken: new pkijs.ContentInfo({
      contentType: pkijs.ContentInfo.SIGNED_DATA,
      content: signedData.toSchema(true),
    }),
  });
  return new Uint8Array(response.toSchema().toBER(false));
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

function reply(body: Uint8Array): Response {
  return new Response(new Uint8Array(body).buffer, {
    status: 200,
    headers: { "content-type": TIME_STAMP_REPLY },
  });
}

export async function createFakeTsa(options: FakeTsaOptions): Promise<FakeTsa> {
  const { mode } = options;
  if (!(FAKE_TSA_MODES as readonly string[]).includes(mode))
    throw new Error(`fake TSA mode must be one of ${FAKE_TSA_MODES.join(", ")}: ${mode}`);
  const clock = options.clock ?? createFakeClock();
  const pki = options.pki ?? (await createTestPki(clock.now()));
  const requests: FakeTsaRequest[] = [];

  const answer = async (parsed: ParsedRequest): Promise<Uint8Array> => {
    const now = clock.now();
    const base = {
      imprint: parsed.imprint,
      nonce: parsed.request.nonce,
      genTime: now,
      essFor: pki.tsa.der,
    };
    const chain = [pki.intermediate];
    switch (mode) {
      case "rejection":
        return statusOnly(pkijs.PKIStatus.rejection);
      case "malformed-der":
        return new Uint8Array([0x30, 0x82, 0xff, 0xff, 0x02, 0x01]);
      case "wrong-imprint":
        return grantedResponse(parsed, pki.tsa, chain, {
          ...base,
          imprint: flipLastByte(parsed.imprint),
        });
      case "wrong-nonce": {
        const nonce = parsed.request.nonce
          ? new Uint8Array(parsed.request.nonce.valueBlock.valueHexView)
          : new Uint8Array([0x01]);
        return grantedResponse(parsed, pki.tsa, chain, {
          ...base,
          nonce: new asn1js.Integer({ valueHex: flipLastByte(nonce).buffer }),
        });
      }
      case "expired-certificate":
        return grantedResponse(parsed, pki.expiredTsa, chain, {
          ...base,
          essFor: pki.expiredTsa.der,
        });
      case "wrong-eku":
        return grantedResponse(parsed, pki.wrongEkuTsa, chain, {
          ...base,
          essFor: pki.wrongEkuTsa.der,
        });
      case "untrusted-root":
        return grantedResponse(parsed, pki.foreignTsa, [], { ...base, essFor: pki.foreignTsa.der });
      case "wrong-ess-cert-id":
        return grantedResponse(parsed, pki.tsa, chain, { ...base, essFor: pki.intermediate.der });
      case "stale-gen-time":
        return grantedResponse(parsed, pki.tsa, chain, {
          ...base,
          genTime: new Date(now.getTime() - DAY_MS),
        });
      case "valid":
      case "timeout":
        return grantedResponse(parsed, pki.tsa, chain, base);
    }
  };

  return {
    mode,
    pki,
    clock,
    requests,
    async fetch(input, init) {
      const request = new Request(input, init);
      const der = new Uint8Array(await request.arrayBuffer());
      const parsed = parseRequest(der);
      requests.push({
        der,
        valid: parsed !== null,
        contentType: request.headers.get("content-type"),
      });
      if (request.signal.aborted) throw abortReason(request.signal);
      if (mode === "timeout")
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(abortReason(request.signal)), {
            once: true,
          });
        });
      if (parsed === null)
        return reply(statusOnly(pkijs.PKIStatus.rejection, BAD_DATA_FORMAT_BITS));
      return reply(await answer(parsed));
    },
  };
}
