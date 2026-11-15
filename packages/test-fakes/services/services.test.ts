import { describe, expect, it } from "vitest";

import { createFakeClock } from "../clock/index.ts";
import { createFakeService, FAKE_SERVICE_MODES, type FakeServiceMode } from "./index.ts";

const URL_OK = "https://service.example.invalid/status";

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("fake outside services", () => {
  it("has exactly the three modes", () => {
    expect([...FAKE_SERVICE_MODES]).toEqual(["ok", "slow", "down"]);
  });

  it("ok answers 200 with the body at once and records the request", async () => {
    const service = createFakeService({ mode: "ok", body: { value: 1 } });
    const response = await service.fetch(URL_OK, { method: "POST", body: "x" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: 1 });
    expect(service.requests.map((r) => [r.method, r.url])).toEqual([["POST", URL_OK]]);
  });

  it("slow answers only once the clock passes the delay", async () => {
    const clock = createFakeClock();
    const service = createFakeService({ mode: "slow", delayMs: 5000, clock });
    const pending = service.fetch(URL_OK);
    clock.advance(4999);
    expect(await settled(pending)).toBe(false);
    clock.advance(1);
    expect((await pending).status).toBe(200);
  });

  it("slow rejects when the caller aborts", async () => {
    const service = createFakeService({ mode: "slow" });
    const controller = new AbortController();
    const pending = service.fetch(URL_OK, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("down fails as a network error, as Node's fetch does", async () => {
    const service = createFakeService({ mode: "down" });
    await expect(service.fetch(URL_OK)).rejects.toThrow(new TypeError("fetch failed"));
    expect(service.requests).toHaveLength(1);
  });

  it.each(["", "OK", "up", "timeout"])("refuses the mode %j", (mode) => {
    expect(() => createFakeService({ mode: mode as FakeServiceMode })).toThrow(/mode/);
  });

  it.each([-1, Number.NaN])("refuses delayMs %s", (delayMs) => {
    expect(() => createFakeService({ mode: "slow", delayMs })).toThrow(RangeError);
  });
});
