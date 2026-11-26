import assert from "node:assert/strict";
import { test } from "node:test";

import { inventedWords, measure } from "./measure.ts";

test("inventedWords gives exactly the asked words in segments of the asked size", () => {
  const texts = inventedWords(45, 20);
  assert.deepEqual(
    texts.map((text) => text.trim().split(" ").length),
    [20, 20, 5],
  );
  assert.deepEqual(inventedWords(0, 20), []);
});

test("a read resumed from a checkpoint gives the full replay's document and replays less", async () => {
  const result = await measure({ words: 400, wordsPerSegment: 10, checkpointEvery: 8 });
  assert.equal(result.segments, 40);
  assert.equal(result.checkpointCount, 5);
  assert.equal(result.resumedSegments, 8);
  assert(result.checkpointVolumeBytes > result.documentBytes);
});

test("a work shorter than the checkpoint distance has no checkpoint and replays whole", async () => {
  const result = await measure({ words: 40, wordsPerSegment: 10, checkpointEvery: 8 });
  assert.equal(result.checkpointCount, 0);
  assert.equal(result.resumedSegments, result.segments);
});
