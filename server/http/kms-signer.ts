// The KMS signer from server/settings (DAN-963, D-71), composed here because
// http is the one composer (docs/server-map.md §2): the SDK's KMSClient for
// the configured region with the SDK's own credential chain, the transport of
// external/keys with its deadline, and the signer that trusts only the
// configured key ARN (no key registry yet). Tests replace the SDK's KMSClient
// with the fake KMS (vi.mock); production code never imports test-support.
import { KMSClient } from "@aws-sdk/client-kms";

import {
  AwsKmsEd25519SigningKeyProvider,
  AwsSdkKmsEd25519Transport,
  type KmsCommandSender,
} from "../external/keys/index.ts";
import type { KmsSettings } from "../settings/index.ts";

/** The deadline of one KMS call. */
export const KMS_CALL_TIMEOUT_MS = 5_000;

/** The AWS KMS signer of the configured key. */
export function kmsSignerOf(settings: KmsSettings): AwsKmsEd25519SigningKeyProvider {
  const client: KmsCommandSender = new KMSClient({ region: settings.region });
  const transport = new AwsSdkKmsEd25519Transport(client, {
    timeoutMs: KMS_CALL_TIMEOUT_MS,
  });
  return new AwsKmsEd25519SigningKeyProvider(transport, settings.keyId, [settings.keyId]);
}
