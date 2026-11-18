// The KMS signer from server/settings (DAN-963, D-71). Production uses the
// SDK's KMSClient and its own credential chain; tests hand in the fake KMS
// through `clientFor`, so this file never imports test-support.
import { KMSClient } from "@aws-sdk/client-kms";

import type { KmsSettings } from "../../settings/index.ts";

import { AwsKmsEd25519SigningKeyProvider } from "./aws-kms-ed25519-signer.ts";
import { AwsSdkKmsEd25519Transport, type KmsCommandSender } from "./aws-kms-sdk-transport.ts";

/** The deadline of one KMS call. */
export const KMS_CALL_TIMEOUT_MS = 5_000;

/** Makes the KMS client of a region; the default is the SDK's KMSClient. */
export type KmsClientFactory = (region: string) => KmsCommandSender;

const sdkClient: KmsClientFactory = (region) => new KMSClient({ region });

/** The signer of the configured key; its ARN is the only trusted version (no key registry yet). */
export function awsKmsSigningKeyProvider(
  settings: KmsSettings,
  clientFor: KmsClientFactory = sdkClient,
): AwsKmsEd25519SigningKeyProvider {
  const transport = new AwsSdkKmsEd25519Transport(clientFor(settings.region), {
    timeoutMs: KMS_CALL_TIMEOUT_MS,
  });
  return new AwsKmsEd25519SigningKeyProvider(transport, settings.keyId, [settings.keyId]);
}
