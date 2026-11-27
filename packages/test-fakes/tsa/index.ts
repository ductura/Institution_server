// Public interface of the fake RFC 3161 time-stamping authority (ISTR-2 step 2).
import "../guard/index.ts";

export {
  createFakeTsa,
  FAKE_TSA_MODES,
  FAKE_TSA_POLICY,
  OID_SHA256,
  OID_SIGNING_CERTIFICATE_V2,
  OID_TST_INFO,
  type FakeTsa,
  type FakeTsaMode,
  type FakeTsaOptions,
  type FakeTsaRequest,
} from "./fake-tsa.ts";
export {
  createTestPki,
  generateTestKeys,
  issueTestCertificate,
  OID_CODE_SIGNING,
  OID_TIME_STAMPING,
  toPem,
  type CertificateSpec,
  type TestCertificate,
  type TestKeyPair,
  type TestPki,
} from "./pki.ts";
