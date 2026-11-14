// Smoke test: the TypeScript toolchain runs and the modules expose their public API.
import { expect, it } from "vitest";

import * as access from "./access.ts";
import * as app from "./app.ts";
import * as store from "./store.ts";

it("modules load and export their public functions", () => {
  expect(typeof access.parseBearer).toBe("function");
  expect(typeof access.canRead).toBe("function");
  expect(typeof access.canWrite).toBe("function");
  expect(typeof store.createStore).toBe("function");
  expect(typeof app.createApp).toBe("function");
});
