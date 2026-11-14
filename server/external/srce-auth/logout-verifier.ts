/**
 * The logout token check the back-channel route receives as a port
 * (docs/server-map.md §2): the composer builds it here and hands it to
 * `session`, which imports only its type. It answers with a result instead
 * of throwing, so the route tells an invalid token (400) from an unavailable
 * provider (503) without importing `LogoutTokenError`.
 */
import type { AuthConfig } from "./config.ts";
import {
  LogoutTokenError,
  verifyLogoutToken,
  type LogoutKeySource,
  type LogoutTokenErrorCode,
} from "./logout-token.ts";
import { accountIssuer, isProviderUnavailable } from "./oidc.ts";

export type LogoutVerification =
  | { ok: true; sub: string | null; sid: string | null; jti: string }
  | { ok: false; reason: "invalid"; code: LogoutTokenErrorCode }
  | { ok: false; reason: "unavailable"; code: "provider_unavailable" | "keys" };

export type LogoutVerifier = {
  /** The account key's spelling of the configured issuer (F-042), as at login. */
  accountIssuer: string;
  verify(token: string): Promise<LogoutVerification>;
};

export type LogoutVerifierOptions = {
  config: AuthConfig;
  /** The issuer string discovery returned, which `iss` must equal exactly. */
  discoveredIssuer: () => Promise<string>;
  keys: LogoutKeySource;
  nowSeconds?: () => number;
};

export function createLogoutVerifier(options: LogoutVerifierOptions): LogoutVerifier {
  const { config, discoveredIssuer, keys, nowSeconds } = options;
  return {
    accountIssuer: accountIssuer(config.issuer),
    async verify(token) {
      try {
        const verified = await verifyLogoutToken(
          token,
          {
            issuer: await discoveredIssuer(),
            clientId: config.clientId,
            alg: config.idTokenAlg,
            clockToleranceSeconds: config.clockToleranceSeconds,
            now: nowSeconds?.() ?? Math.floor(Date.now() / 1000),
          },
          keys,
        );
        return { ok: true, sub: verified.sub, sid: verified.sid, jti: verified.jti };
      } catch (error) {
        if (error instanceof LogoutTokenError) {
          return { ok: false, reason: "invalid", code: error.code };
        }
        return {
          ok: false,
          reason: "unavailable",
          code: isProviderUnavailable(error) ? "provider_unavailable" : "keys",
        };
      }
    },
  };
}
