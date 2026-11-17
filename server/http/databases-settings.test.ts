// DAN-826-2b (contract Ductus#1836 c.6935829233): the settings writer the
// entry point mounts is the settings.set_value adapter over the application
// withActor of server/database, never another writer. The adapter's factory
// is replaced here only to see what it is given.
import { describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => ({ calls: [] as unknown[], writer: { setValue: vi.fn() } }));

vi.mock(import("../database/index.ts"), async (original) => ({
  ...(await original()),
  createSettingsWriter: (withActor: unknown) => {
    made.calls.push(withActor);
    return made.writer;
  },
}));

const { withActor } = await import("../database/index.ts");
const { createDatabases } = await import("./databases.ts");

describe("createDatabases().main.settingsWriter", () => {
  it("is the settings.set_value adapter over the application withActor", () => {
    const main = createDatabases().main;
    expect(main.settingsWriter).toBe(made.writer);
    expect(made.calls).toEqual([withActor]);
    expect(main.withActor).toBe(withActor);
  });
});
