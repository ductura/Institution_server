import assert from "node:assert/strict";
import { test } from "node:test";

import { DeadlineEncryption } from "./index.ts";

const DEADLINE_MS = Date.UTC(2026, 11, 20, 12);
const SYNTHETIC_TEXT = Buffer.from("Izmišljeni rad o školskom vrtu na Mjesecu.");

for (const offsetMs of [-1, 0, 1]) {
  test(`opens only at or after the deadline (offset ${offsetMs} ms)`, () => {
    let nowMs = DEADLINE_MS - 2;
    const encryption = new DeadlineEncryption(() => nowMs);
    const work = encryption.seal("demo-work-1", DEADLINE_MS, SYNTHETIC_TEXT);
    nowMs = DEADLINE_MS + offsetMs;

    if (offsetMs < 0) {
      assert.throws(() => encryption.open(work), /Deadline has not been reached/);
    } else {
      assert.deepEqual(encryption.open(work), SYNTHETIC_TEXT);
    }
  });
}

for (const invalidTime of [NaN, Infinity, -Infinity, 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects invalid deadline and clock values (${invalidTime})`, () => {
    const encryption = new DeadlineEncryption(() => invalidTime);
    assert.throws(() => encryption.seal("demo-work-1", invalidTime, SYNTHETIC_TEXT), RangeError);
    const work = encryption.seal("demo-work-1", DEADLINE_MS, SYNTHETIC_TEXT);
    assert.throws(() => encryption.open(work), RangeError);
  });
}

test("withstands changes to the work identity, deadline, and ciphertext", () => {
  const encryption = new DeadlineEncryption(() => DEADLINE_MS - 1);
  const work = encryption.seal("demo-work-1", DEADLINE_MS, SYNTHETIC_TEXT);
  assert.throws(() => encryption.open({ ...work, deadlineMs: DEADLINE_MS - 1 }));

  const readyEncryption = new DeadlineEncryption(() => DEADLINE_MS);
  const readyWork = readyEncryption.seal("demo-work-1", DEADLINE_MS, SYNTHETIC_TEXT);
  assert.throws(() => readyEncryption.open({ ...readyWork, workId: "demo-impostor" }));

  const ciphertext = Buffer.from(readyWork.content.ciphertext);
  ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 1, 0);
  assert.throws(() =>
    readyEncryption.open({ ...readyWork, content: { ...readyWork.content, ciphertext } }),
  );
});

test("refuses records from another simulator and pieces swapped between works", () => {
  const encryption = new DeadlineEncryption(() => DEADLINE_MS);
  const otherEncryption = new DeadlineEncryption(() => DEADLINE_MS);
  const first = encryption.seal("demo-work-1", DEADLINE_MS, SYNTHETIC_TEXT);
  const second = encryption.seal("demo-work-2", DEADLINE_MS, SYNTHETIC_TEXT);
  assert.throws(() => otherEncryption.open(first));
  assert.throws(() => encryption.open({ ...first, wrappedKey: second.wrappedKey }));
  assert.throws(() => encryption.open({ ...first, content: second.content }));

  // Same identity and deadline isolate the per-seal content key from metadata binding.
  const resealed = encryption.seal(first.workId, first.deadlineMs, SYNTHETIC_TEXT);
  assert.throws(() => encryption.open({ ...first, wrappedKey: resealed.wrappedKey }));
  assert.deepEqual(encryption.open(resealed), SYNTHETIC_TEXT);
});
