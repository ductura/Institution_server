// DAN-840-3b (contract Ductus#1836 c.6940273164): the WebAuthn credential port
// the entry point builds is the adapter over the application withActor of
// server/database, never another. The factory is replaced here only to see
// what it is given.
import { describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => ({ calls: [] as unknown[], port: { list: vi.fn() } }));

vi.mock(import("../database/index.ts"), async (original) => ({
  ...(await original()),
  createWebAuthnCredentials: (withActor: unknown) => {
    made.calls.push(withActor);
    return made.port as never;
  },
}));

const { withActor } = await import("../database/index.ts");
const { createDatabases } = await import("./databases.ts");

describe("createDatabases().main.webauthnCredentials", () => {
  it("is the WebAuthn credential adapter over the application withActor", () => {
    expect(createDatabases().main.webauthnCredentials).toBe(made.port);
    expect(made.calls).toEqual([withActor]);
  });
});
