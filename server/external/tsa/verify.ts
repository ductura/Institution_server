import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

import { tsaFailure, type TsaErrorCode, type TsaResult } from "./errors.ts";
import { isDigest } from "./request.ts";
import {
  ESS_HASHES,
  OID_EXT_KEY_USAGE,
  OID_SHA256,
  OID_SIGNING_CERTIFICATE_V2,
  OID_SUBJECT_KEY_IDENTIFIER,
  OID_TIME_STAMPING,
  OID_TST_INFO,
} from "./oids.ts";

// Check of a TimeStampResp (RFC 3161 §2.4.2) for ISTR-2 step 1, in the order of
// docs/plan/ISTR-2-TSA.md §4 step 1: status, imprint algorithm and value,
// nonce, genTime, the signer certificate (ESSCertIDv2, validity at genTime,
// EKU timeStamping), the CMS signature and the chain to a pinned anchor at
// genTime. Every expected failure is a result with a reason code; nothing a
// TSA sends can make this function throw. No network: the chain is built only
// from the response, `extraCertificates` and `anchors`.

export type TimeStampExpectation = {
  /** The 32-byte SHA-256 digest that was sent. */
  readonly digest: Uint8Array;
  /** The nonce of this attempt, exactly as newNonce returned it. */
  readonly nonce: Uint8Array;
  /** genTime must lie in [notBefore, notAfter]. */
  readonly notBefore: Date;
  readonly notAfter: Date;
};

export type TrustMaterial = {
  /** Pinned root certificates (O-3 (a)). */
  readonly anchors: readonly pkijs.Certificate[];
  /** Stored intermediates for an offline check (O-5 (b)); default none. */
  readonly extraCertificates?: readonly pkijs.Certificate[];
};

export type VerifiedTimeStamp = {
  /** The response exactly as received: the bytes step 3 stores as `.tsr`. */
  readonly der: Uint8Array;
  readonly genTime: Date;
  /** TSTInfo.serialNumber, lower-case hex. */
  readonly serialNumber: string;
  readonly policy: string;
  /** DER of the TSA certificate that signed, then the path up to the anchor. */
  readonly certificatePath: readonly Uint8Array[];
};

const fail = <T>(code: TsaErrorCode): TsaResult<T> => tsaFailure(code);

function bytesOf(view: ArrayBuffer | ArrayBufferView): Uint8Array {
  return view instanceof ArrayBuffer
    ? new Uint8Array(view)
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The magnitude of a DER INTEGER: leading zero bytes do not count. */
function integerMagnitude(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Parse exactly one DER value, or null for anything else (trailing bytes too). */
function parseOne(der: Uint8Array): asn1js.AsnType | null {
  if (der.byteLength === 0) return null;
  const asn = asn1js.fromBER(der);
  if (asn.offset === -1 || asn.offset !== der.byteLength) return null;
  return asn.result;
}

function attempt<T>(build: () => T): T | null {
  try {
    return build();
  } catch {
    return null;
  }
}

async function attemptAsync<T>(build: () => Promise<T>): Promise<T | null> {
  try {
    return await build();
  } catch {
    return null;
  }
}

/** Certificates from DER bytes; null if any of them does not parse. */
export function parseCertificates(ders: readonly Uint8Array[]): pkijs.Certificate[] | null {
  const out: pkijs.Certificate[] = [];
  for (const der of ders) {
    const asn = parseOne(der);
    const certificate = asn === null ? null : attempt(() => new pkijs.Certificate({ schema: asn }));
    if (certificate === null) return null;
    out.push(certificate);
  }
  return out;
}

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)-----END CERTIFICATE-----/gu;

/** Trust anchors from PEM text (O-3 (a): pinned in the repository). */
export function parseAnchorsPem(pem: string): TsaResult<pkijs.Certificate[]> {
  const ders = [...pem.matchAll(PEM_BLOCK)].map(
    (m) => new Uint8Array(Buffer.from((m[1] ?? "").replace(/\s+/gu, ""), "base64")),
  );
  const rest = pem.replace(PEM_BLOCK, "").trim();
  if (ders.length === 0 || rest !== "") return fail("TSA_ANCHORS_INVALID");
  const certificates = parseCertificates(ders);
  return certificates === null ? fail("TSA_ANCHORS_INVALID") : { ok: true, value: certificates };
}

function certificateDer(certificate: pkijs.Certificate): Uint8Array {
  return new Uint8Array(certificate.toSchema().toBER(false));
}

function findSigner(
  signerInfo: pkijs.SignerInfo,
  certificates: readonly pkijs.Certificate[],
): pkijs.Certificate | null {
  const { sid } = signerInfo;
  if (sid instanceof pkijs.IssuerAndSerialNumber)
    return (
      certificates.find(
        (c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber),
      ) ?? null
    );
  // [0] SubjectKeyIdentifier
  if (!(sid instanceof asn1js.Primitive)) return null;
  const keyId = bytesOf(sid.valueBlock.valueHexView);
  if (keyId.byteLength === 0) return null;
  return (
    certificates.find((c) => {
      const extension = c.extensions?.find((e) => e.extnID === OID_SUBJECT_KEY_IDENTIFIER);
      const value = extension?.parsedValue as asn1js.OctetString | undefined;
      return value !== undefined && equalBytes(bytesOf(value.valueBlock.valueHexView), keyId);
    }) ?? null
  );
}

/** RFC 5035: the first ESSCertIDv2 of SigningCertificateV2 must hash the signer certificate. */
async function essCertIdMatches(
  signerInfo: pkijs.SignerInfo,
  signerDer: Uint8Array,
): Promise<boolean> {
  const attribute = signerInfo.signedAttrs?.attributes.find(
    (a) => a.type === OID_SIGNING_CERTIFICATE_V2,
  );
  if (!attribute || attribute.values.length !== 1) return false;
  const signingCertificate = attribute.values[0];
  if (!(signingCertificate instanceof asn1js.Sequence)) return false;
  const certs = signingCertificate.valueBlock.value[0];
  if (!(certs instanceof asn1js.Sequence)) return false;
  const first = certs.valueBlock.value[0];
  if (!(first instanceof asn1js.Sequence)) return false;
  const [head, second] = first.valueBlock.value;
  let hashOid = OID_SHA256;
  let certHash: asn1js.AsnType | undefined = head;
  if (head instanceof asn1js.Sequence) {
    const algorithm = attempt(() => new pkijs.AlgorithmIdentifier({ schema: head }));
    if (algorithm === null) return false;
    hashOid = algorithm.algorithmId;
    certHash = second;
  }
  const hashName = ESS_HASHES[hashOid];
  if (hashName === undefined || !(certHash instanceof asn1js.OctetString)) return false;
  const actual = new Uint8Array(await crypto.subtle.digest(hashName, signerDer.slice()));
  return equalBytes(actual, bytesOf(certHash.valueBlock.valueHexView));
}

/** RFC 3161 §2.3: one critical EKU extension whose only purpose is timeStamping. */
function hasTimeStampingEku(certificate: pkijs.Certificate): boolean {
  const ekus = certificate.extensions?.filter((e) => e.extnID === OID_EXT_KEY_USAGE) ?? [];
  if (ekus.length !== 1) return false;
  const [eku] = ekus;
  if (!eku?.critical || !(eku.parsedValue instanceof pkijs.ExtKeyUsage)) return false;
  const purposes = eku.parsedValue.keyPurposes;
  return purposes.length === 1 && purposes[0] === OID_TIME_STAMPING;
}

const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";

function singleValue(signerInfo: pkijs.SignerInfo, type: string): asn1js.AsnType | null {
  const found = signerInfo.signedAttrs?.attributes.filter((a) => a.type === type) ?? [];
  const [attribute] = found;
  if (found.length !== 1 || !attribute || attribute.values.length !== 1) return null;
  return (attribute.values[0] as asn1js.AsnType | undefined) ?? null;
}

/**
 * RFC 5652 §5.4 and §5.6 over a TSTInfo: content-type is tSTInfo, message-digest
 * is the hash of eContent with the signer's digest algorithm (SHA-2 only), and
 * the signature covers the DER of the signed attributes. pkijs' own
 * SignedData.verify needs the time-stamped data itself for a TSTInfo, which
 * the port never has (only its digest), so the same steps run here.
 */
async function signatureValid(
  signedData: pkijs.SignedData,
  signerInfo: pkijs.SignerInfo,
  signer: pkijs.Certificate,
): Promise<boolean> {
  const contentType = singleValue(signerInfo, OID_CONTENT_TYPE);
  if (
    !(contentType instanceof asn1js.ObjectIdentifier) ||
    contentType.valueBlock.toString() !== OID_TST_INFO
  )
    return false;
  const messageDigest = singleValue(signerInfo, OID_MESSAGE_DIGEST);
  if (!(messageDigest instanceof asn1js.OctetString)) return false;
  const hashName = ESS_HASHES[signerInfo.digestAlgorithm.algorithmId];
  const eContent = signedData.encapContentInfo.eContent;
  if (hashName === undefined || !eContent || !signerInfo.signedAttrs) return false;
  const content = bytesOf(eContent.getValue()).slice();
  const actual = new Uint8Array(await crypto.subtle.digest(hashName, content));
  if (!equalBytes(actual, bytesOf(messageDigest.valueBlock.valueHexView))) return false;
  const signed = signerInfo.signedAttrs.encodedValue;
  const engine = pkijs.getCrypto(true);
  return signerInfo.signatureAlgorithm.algorithmId === OID_RSA_ENCRYPTION
    ? engine.verifyWithPublicKey(
        signed,
        signerInfo.signature,
        signer.subjectPublicKeyInfo,
        signerInfo.signatureAlgorithm,
        hashName,
      )
    : engine.verifyWithPublicKey(
        signed,
        signerInfo.signature,
        signer.subjectPublicKeyInfo,
        signerInfo.signatureAlgorithm,
      );
}

function validAt(certificate: pkijs.Certificate, at: Date): boolean {
  return certificate.notBefore.value <= at && at <= certificate.notAfter.value;
}

type Token = {
  readonly signedData: pkijs.SignedData;
  readonly signerInfo: pkijs.SignerInfo;
  readonly tstInfo: pkijs.TSTInfo;
  readonly certificates: pkijs.Certificate[];
};

/** Status, then the token structure: SignedData with one signer over a TSTInfo v1. */
function readToken(der: Uint8Array): TsaResult<Token> {
  const asn = parseOne(der);
  const response = asn === null ? null : attempt(() => new pkijs.TimeStampResp({ schema: asn }));
  if (response === null) return fail("TSA_MALFORMED");
  const { status } = response.status;
  if (status !== pkijs.PKIStatus.granted && status !== pkijs.PKIStatus.grantedWithMods)
    return fail("TSA_REJECTED");
  const token = response.timeStampToken;
  if (!token || token.contentType !== pkijs.ContentInfo.SIGNED_DATA) return fail("TSA_MALFORMED");
  const signedData = attempt(() => new pkijs.SignedData({ schema: token.content }));
  if (signedData === null || signedData.signerInfos.length !== 1) return fail("TSA_MALFORMED");
  const [signerInfo] = signedData.signerInfos;
  const { eContentType, eContent } = signedData.encapContentInfo;
  if (!signerInfo || eContentType !== OID_TST_INFO || !eContent) return fail("TSA_MALFORMED");
  const content = attempt(() => bytesOf(eContent.getValue()));
  const tstAsn = content === null ? null : parseOne(content);
  const tstInfo = tstAsn === null ? null : attempt(() => new pkijs.TSTInfo({ schema: tstAsn }));
  if (tstInfo === null || tstInfo.version !== 1) return fail("TSA_MALFORMED");
  const certificates = (signedData.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  return { ok: true, value: { signedData, signerInfo, tstInfo, certificates } };
}

/**
 * Checks `der` against what was asked and the trust material. Returns the
 * verified time stamp or the first failed check; never throws for any input.
 * A structure pkijs or asn1js cannot handle at any later step (for example a
 * certificate whose date does not convert) is TSA_MALFORMED.
 */
export async function verifyTimeStampResponse(
  der: Uint8Array,
  expectation: TimeStampExpectation,
  trust: TrustMaterial,
): Promise<TsaResult<VerifiedTimeStamp>> {
  try {
    return await verifyChecked(der, expectation, trust);
  } catch {
    return fail("TSA_MALFORMED");
  }
}

async function verifyChecked(
  der: Uint8Array,
  expectation: TimeStampExpectation,
  trust: TrustMaterial,
): Promise<TsaResult<VerifiedTimeStamp>> {
  if (!isDigest(expectation.digest)) return fail("TSA_DIGEST_INVALID");
  const read = readToken(der);
  if (!read.ok) return read;
  const { signedData, signerInfo, tstInfo, certificates } = read.value;

  const imprint = tstInfo.messageImprint;
  if (imprint.hashAlgorithm.algorithmId !== OID_SHA256) return fail("TSA_IMPRINT_ALGORITHM");
  if (!equalBytes(bytesOf(imprint.hashedMessage.valueBlock.valueHexView), expectation.digest))
    return fail("TSA_IMPRINT_MISMATCH");

  const nonce = tstInfo.nonce ? bytesOf(tstInfo.nonce.valueBlock.valueHexView) : null;
  if (nonce === null || !equalBytes(integerMagnitude(nonce), integerMagnitude(expectation.nonce)))
    return fail("TSA_NONCE_MISMATCH");

  const { genTime } = tstInfo;
  if (
    !(genTime instanceof Date) ||
    Number.isNaN(genTime.getTime()) ||
    genTime < expectation.notBefore ||
    genTime > expectation.notAfter
  )
    return fail("TSA_GEN_TIME");

  const signer = findSigner(signerInfo, certificates);
  if (signer === null) return fail("TSA_SIGNER_CERTIFICATE_MISSING");
  const signerDer = certificateDer(signer);
  if (!(await attemptAsync(() => essCertIdMatches(signerInfo, signerDer))))
    return fail("TSA_ESS_CERT_ID");
  if (!validAt(signer, genTime)) return fail("TSA_CERTIFICATE_EXPIRED");
  if (!hasTimeStampingEku(signer)) return fail("TSA_EKU");

  if ((await attemptAsync(() => signatureValid(signedData, signerInfo, signer))) !== true)
    return fail("TSA_SIGNATURE");

  if (trust.anchors.length === 0) return fail("TSA_ANCHORS_INVALID");
  const others = [...certificates, ...(trust.extraCertificates ?? [])].filter(
    (c) => !equalBytes(certificateDer(c), signerDer),
  );
  const engine = new pkijs.CertificateChainValidationEngine({
    trustedCerts: [...trust.anchors],
    // The engine takes the last certificate as the end entity.
    certs: [...others, signer],
    checkDate: genTime,
  });
  const chain = await attemptAsync(() => engine.verify());
  const path = chain?.certificatePath ?? [];
  const leaf = path[0];
  if (
    chain?.result !== true ||
    path.length < 2 ||
    !leaf ||
    !equalBytes(certificateDer(leaf), signerDer)
  )
    return fail("TSA_CHAIN");

  return {
    ok: true,
    value: {
      der: der.slice(),
      genTime,
      serialNumber: toHex(integerMagnitude(bytesOf(tstInfo.serialNumber.valueBlock.valueHexView))),
      policy: tstInfo.policy,
      certificatePath: path.map(certificateDer),
    },
  };
}
