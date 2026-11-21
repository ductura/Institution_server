import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { DeadlineEncryption } from "./index.ts";
import type { SealedWork } from "./index.ts";

const DEADLINE_MS = Date.UTC(2026, 11, 20, 12);
const WARMUP_ROUNDS = 30;
const SAMPLES = 300;
const KIB = 1024;

function encryptedSize(work: SealedWork): number {
  return [work.content, work.wrappedKey].reduce(
    (sum, { ciphertext, nonce, tag }) => sum + ciphertext.length + nonce.length + tag.length,
    0,
  );
}

function percentiles(samples: number[]): { p50: string; p95: string } {
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.ceil(samples.length * 0.5) - 1];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  assert(p50 !== undefined && p95 !== undefined);
  return { p50: p50.toFixed(3), p95: p95.toFixed(3) };
}

function measure(sizeKiB: number) {
  const plaintext = Buffer.alloc(
    sizeKiB * KIB,
    "Synthetic document about a school garden on the Moon. ",
  );
  const encryption = new DeadlineEncryption(() => DEADLINE_MS);
  const sealTimes: number[] = [];
  const openTimes: number[] = [];
  let overheadBytes = 0;

  for (let round = 0; round < WARMUP_ROUNDS + SAMPLES; round += 1) {
    const workId = `demo-work-${sizeKiB}-${round}`;
    const start = performance.now();
    const work = encryption.seal(workId, DEADLINE_MS, plaintext);
    const sealedAt = performance.now();
    const opened = encryption.open(work);
    const openedAt = performance.now();

    assert(opened.equals(plaintext));
    overheadBytes = encryptedSize(work) - plaintext.length;
    if (round >= WARMUP_ROUNDS) {
      sealTimes.push(sealedAt - start);
      openTimes.push(openedAt - sealedAt);
    }
  }

  const seal = percentiles(sealTimes);
  const open = percentiles(openTimes);
  return {
    sizeKiB,
    sealP50Ms: seal.p50,
    sealP95Ms: seal.p95,
    openP50Ms: open.p50,
    openP95Ms: open.p95,
    overheadBytes,
  };
}

console.table([16, 256, 1024].map(measure));
