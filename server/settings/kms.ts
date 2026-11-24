// The KMS signer's configuration (DAN-963, D-71), read at startup. None of
// the three set selects no KMS (as before); any one set asks for all three,
// so an incomplete configuration never starts, in any NODE_ENV. Present means an
// own data property, "" included; a getter is a problem and is not called.
// Problems name the variable, never its value.
import { type Env, ownValue } from "./test-mode.ts";

export type KmsSettings = {
  readonly provider: "aws";
  readonly keyId: string;
  readonly region: string;
};

const PROVIDER = "DUCTUS_KMS_PROVIDER";
const KEY_ID = "DUCTUS_KMS_KEY_ID";
const REGION = "DUCTUS_KMS_REGION";
const REGION_PATTERN = "[a-z]{2}(?:-[a-z]+)+-[1-9]\\d?";
const REGION_RE = new RegExp(`^${REGION_PATTERN}$`, "u");
// Only a key ARN: the signer trusts exactly this version, never an alias.
const KEY_ARN_RE = new RegExp(
  `^arn:(?:aws|aws-cn|aws-us-gov):kms:(${REGION_PATTERN}):\\d{12}:key/` +
    "(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$",
  "u",
);

function read(env: Env): { problems: string[]; settings: KmsSettings | null } {
  const [provider, keyId, region] = [PROVIDER, KEY_ID, REGION].map((name) => ownValue(env, name));
  if (provider === undefined && keyId === undefined && region === undefined) {
    return { problems: [], settings: null };
  }
  const problems: string[] = [];
  const unset = (value: string | null | undefined) => value === undefined || value === "";
  if (unset(provider)) problems.push(`${PROVIDER} is not set`);
  else if (provider !== "aws") problems.push(`${PROVIDER} is not a known provider`);
  const arn = typeof keyId === "string" ? KEY_ARN_RE.exec(keyId) : null;
  if (unset(keyId)) problems.push(`${KEY_ID} is not set`);
  else if (arn === null) problems.push(`${KEY_ID} is not a KMS key ARN`);
  const regionOk = typeof region === "string" && REGION_RE.test(region);
  if (unset(region)) problems.push(`${REGION} is not set`);
  else if (!regionOk) problems.push(`${REGION} is not an AWS region`);
  if (arn !== null && regionOk && arn[1] !== region) {
    problems.push(`${KEY_ID} is not in ${REGION}`);
  }
  if (problems.length > 0 || typeof keyId !== "string" || typeof region !== "string") {
    return { problems, settings: null };
  }
  return { problems, settings: Object.freeze({ provider: "aws", keyId, region }) };
}

/** The problems of the KMS variables, by name only; empty when none or all three are usable. */
export function kmsProblems(env: Env): string[] {
  return read(env).problems;
}

/** The KMS configuration; null when no KMS variable is set or any problem exists. */
export function kmsSettings(env: Env): KmsSettings | null {
  return read(env).settings;
}
