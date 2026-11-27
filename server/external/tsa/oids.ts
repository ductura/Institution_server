// Object identifiers the port checks (RFC 3161, RFC 5035, RFC 5280).
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
export const OID_SHA384 = "2.16.840.1.101.3.4.2.2";
export const OID_SHA512 = "2.16.840.1.101.3.4.2.3";
export const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
export const OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";
export const OID_EXT_KEY_USAGE = "2.5.29.37";
export const OID_SUBJECT_KEY_IDENTIFIER = "2.5.29.14";
export const OID_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";

/** Hash algorithms ESSCertIDv2 may name, with their WebCrypto names. */
export const ESS_HASHES: Readonly<Record<string, string>> = {
  [OID_SHA256]: "SHA-256",
  [OID_SHA384]: "SHA-384",
  [OID_SHA512]: "SHA-512",
};
