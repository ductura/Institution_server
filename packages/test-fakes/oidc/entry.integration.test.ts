import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));

// Starts server.ts as the entry point and returns its first line of output.
function firstLine(env: Readonly<Record<string, string>>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SERVER], { env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const end = out.indexOf("\n");
      if (end >= 0) {
        child.kill();
        resolve(out.slice(0, end));
      }
    });
    child.on("error", reject);
    child.on("exit", () => reject(new Error(`exited before listening: ${out}`)));
  });
}

// U9 (server#5 review): run directly, the provider binds loopback only.
test("the entry point listens on 127.0.0.1, not on every interface", async () => {
  const line = await firstLine({ NODE_ENV: "test", PORT: "0" });
  expect(line).toMatch(/listening 127\.0\.0\.1:\d+$/);
}, 20_000);

// STG-OIDC: only with DUCTURA_DEPLOYMENT=staging does the entry point listen on
// every interface, for Render; the values are invented test values.
test("the entry point in staging listens on 0.0.0.0 with the public issuer", async () => {
  const line = await firstLine({
    PORT: "0",
    DUCTURA_DEPLOYMENT: "staging",
    APP_ORIGIN: "https://ductura-staging.vercel.app",
    ISSUER: "https://ductura-fake-oidc-staging.onrender.com",
    FAKE_OIDC_CLIENT_SECRET: "test-client-secret-0123456789abcdef",
    FAKE_OIDC_COOKIE_KEY: "test-cookie-key-0123456789abcdefghij",
  });
  expect(line).toMatch(
    /on https:\/\/ductura-fake-oidc-staging\.onrender\.com, listening 0\.0\.0\.0:\d+$/,
  );
}, 20_000);
