// S-1F-a (DAN-783): the registry reports each database in the words of
// CapabilityStatus of the API contract, the field readiness (S-1M-a) will
// send. server/database may not import the contract, so this test, in the one
// area that sees both, keeps the two lists equal.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { DATABASE_HEALTH_WORDS } from "../database/index.ts";

type Schema = { const?: unknown; anyOf?: Schema[]; properties?: Record<string, Schema> };

describe("database health words", () => {
  it("are the words of capabilities.database in the ready contract", () => {
    const ready = ROUTES.find((route) => route.id === "platform.ready.get");
    const body = ready?.responses[0]?.body as Schema | undefined;
    const database = body?.properties?.capabilities?.properties?.database;
    const words = database?.anyOf?.map((option) => option.const);
    expect(words).toBeDefined();
    expect([...(words ?? [])].sort()).toEqual([...DATABASE_HEALTH_WORDS].sort());
  });
});
