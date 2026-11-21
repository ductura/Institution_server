import { once } from "node:events";
import { Worker } from "node:worker_threads";

import { expect, it } from "vitest";

import { waitForPdfWorker } from "./worker-result.ts";

it("cuts off a stalled PDF worker and waits for its exit", async () => {
  const thread = new Worker(new URL("data:text/javascript,setInterval(() => {}, 1000)"));
  const exited = once(thread, "exit");
  await once(thread, "online");
  expect(await waitForPdfWorker(thread, 25)).toEqual({ ok: false, code: "PDF_INVALID" });
  expect(await exited).toEqual([1]);
  expect(thread.threadId).toBe(-1);
});
