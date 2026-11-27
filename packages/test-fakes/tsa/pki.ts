import * as asn1js from "asn1js";
import type { webcrypto } from "node:crypto";

import * as pkijs from "pkijs";

// A throwaway PKI for the fake time-stamping authority (ISTR-2 step 2). Every
// key is generated in memory when a test asks for it; nothing is read from or
// written to disk, so no secret ever reaches the repository. ECDSA P-256 with
// SHA-256 keeps generation fast; the port does not depend on the algorithm.

export const OID_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";
export const OID_CODE_SIGNING = "1.3.6.1.5.5.7.3.3";
const OID_COMMON_NAME = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";

const KEY_ALGORITHM: webcrypto.EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const DAY_MS = 24 * 60 * 60 * 1000;

export type TestKeyPair = {
  readonly publicKey: webcrypto.CryptoKey;
  readonly privateKey: webcrypto.CryptoKey;
};

export type TestCertificate = {
  readonly certificate: pkijs.Certificate;
  /** DER bytes of `certificate`. */
  readonly der: Uint8Array;
  readonly keys: TestKeyPair;
};

export type TestPki = {
  /** The self-signed root: the trust anchor a test hands to the port. */
  readonly root: TestCertificate;
  /** An intermediate CA under `root` that issues every TSA certificate below. */
  readonly intermediate: TestCertificate;
  /** A valid TSA certificate: EKU timeStamping only, critical. */
  readonly tsa: TestCertificate;
  /** A TSA certificate that expired before `now`. */
  readonly expiredTsa: TestCertificate;
  /** A TSA certificate whose only EKU is codeSigning. */
  readonly wrongEkuTsa: TestCertificate;
  /** A root nobody trusts, with its own valid TSA certificate. */
  readonly foreignRoot: TestCertificate;
  readonly foreignTsa: TestCertificate;
  /** The moment the certificates were made valid around. */
  readonly now: Date;
};

function name(commonName: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: OID_COMMON_NAME,
        value: new asn1js.Utf8String({ value: commonName }),
      }),
    ],
  });
}

function extension(extnID: string, critical: boolean, value: asn1js.BaseBlock): pkijs.Extension {
  return new pkijs.Extension({
    extnID,
    critical,
    extnValue: value.toBER(false),
  });
}

/** KeyUsage bits: digitalSignature (0) for a TSA, keyCertSign (5) and cRLSign (6) for a CA. */
function keyUsage(ca: boolean): asn1js.BitString {
  // Bit 0 is the most significant bit of the first byte.
  const bits = ca ? 0b0000_0110 : 0b1000_0000;
  return new asn1js.BitString({ valueHex: new Uint8Array([bits]).buffer, unusedBits: ca ? 1 : 7 });
}

let serialCounter = 1;

export type CertificateSpec = {
  readonly commonName: string;
  readonly keys: TestKeyPair;
  /** Issuer name and key; omitted for a self-signed certificate. */
  readonly issuer?: TestCertificate;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly ca: boolean;
  /** Extended key usages; omitted means no EKU extension. */
  readonly eku?: readonly string[];
  readonly ekuCritical?: boolean;
};

export async function generateTestKeys(): Promise<TestKeyPair> {
  return (await crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])) as TestKeyPair;
}

export async function issueTestCertificate(spec: CertificateSpec): Promise<TestCertificate> {
  const certificate = new pkijs.Certificate();
  certificate.version = 2;
  const serial = serialCounter++;
  certificate.serialNumber = new asn1js.Integer({ value: serial });
  certificate.subject = name(spec.commonName);
  certificate.issuer = spec.issuer ? spec.issuer.certificate.subject : name(spec.commonName);
  certificate.notBefore.value = spec.notBefore;
  certificate.notAfter.value = spec.notAfter;
  const extensions = [
    extension(OID_BASIC_CONSTRAINTS, true, new pkijs.BasicConstraints({ cA: spec.ca }).toSchema()),
    extension(OID_KEY_USAGE, true, keyUsage(spec.ca)),
  ];
  if (spec.eku)
    extensions.push(
      extension(
        OID_EXT_KEY_USAGE,
        spec.ekuCritical ?? true,
        new pkijs.ExtKeyUsage({ keyPurposes: [...spec.eku] }).toSchema(),
      ),
    );
  certificate.extensions = extensions;
  await certificate.subjectPublicKeyInfo.importKey(spec.keys.publicKey);
  await certificate.sign((spec.issuer?.keys ?? spec.keys).privateKey, "SHA-256");
  const der = new Uint8Array(certificate.toSchema(true).toBER(false));
  return { certificate, der, keys: spec.keys };
}

/**
 * A fresh root, intermediate and TSA certificates valid around `now`
 * (default: the current time). Each call makes new keys.
 */
export async function createTestPki(now: Date = new Date()): Promise<TestPki> {
  const at = (days: number): Date => new Date(now.getTime() + days * DAY_MS);
  const root = await issueTestCertificate({
    commonName: "Ductura testni korijen (izmišljen)",
    keys: await generateTestKeys(),
    notBefore: at(-3650),
    notAfter: at(3650),
    ca: true,
  });
  const intermediate = await issueTestCertificate({
    commonName: "Ductura testni posrednik (izmišljen)",
    keys: await generateTestKeys(),
    issuer: root,
    notBefore: at(-1825),
    notAfter: at(1825),
    ca: true,
  });
  const tsaSpec = (commonName: string, keys: TestKeyPair) => ({
    commonName,
    keys,
    issuer: intermediate,
    notBefore: at(-365),
    notAfter: at(365),
    ca: false,
    eku: [OID_TIME_STAMPING],
  });
  const tsa = await issueTestCertificate(
    tsaSpec("Ductura testni TSA (izmišljen)", await generateTestKeys()),
  );
  const expiredTsa = await issueTestCertificate({
    ...tsaSpec("Ductura istekli testni TSA (izmišljen)", await generateTestKeys()),
    notBefore: at(-730),
    notAfter: at(-1),
  });
  const wrongEkuTsa = await issueTestCertificate({
    ...tsaSpec("Ductura testni potpisnik koda (izmišljen)", await generateTestKeys()),
    eku: [OID_CODE_SIGNING],
  });
  const foreignRoot = await issueTestCertificate({
    commonName: "Strani testni korijen (izmišljen)",
    keys: await generateTestKeys(),
    notBefore: at(-3650),
    notAfter: at(3650),
    ca: true,
  });
  const foreignTsa = await issueTestCertificate({
    ...tsaSpec("Strani testni TSA (izmišljen)", await generateTestKeys()),
    issuer: foreignRoot,
  });
  return { root, intermediate, tsa, expiredTsa, wrongEkuTsa, foreignRoot, foreignTsa, now };
}

/** PEM text of a DER certificate, the format trust anchors are pinned in. */
export function toPem(der: Uint8Array): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}
