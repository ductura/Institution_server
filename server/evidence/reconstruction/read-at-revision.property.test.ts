import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { sha256WebCrypto } from "../../domain/index.ts";
import type { ReconstructionCheckpoint } from "./checkpoint.ts";
import { buildReconstructionCheckpoints, readDocumentAtRevision } from "./read-at-revision.ts";
import { buildRecord, canonical, EMPTY, replayer } from "./record.fixture.ts";

// SRV-1503 acceptance (2) and (3): for any invented record, any revision and
// any checkpoint the store may hold, intact or damaged, the read gives the
// same bytes as the replay of the full record.
const text = fc.stringMatching(/^[a-zčćžšđ ,.]{1,12}$/);
const record = fc.array(text, { minLength: 1, maxLength: 24 });

type Damage = "none" | "body" | "content_hash" | "segment_hash" | "revision";
const damage = fc.constantFrom<Damage>("none", "body", "content_hash", "segment_hash", "revision");

async function damaged(checkpoint: ReconstructionCheckpoint, how: Damage, flip: string) {
  switch (how) {
    case "none":
      return checkpoint;
    case "body": {
      // Another text that still hashes to its own key: only the record catches it.
      const body = checkpoint.body.replace(/"text":"/, `"text":"${flip}`);
      return { ...checkpoint, body, contentHash: await sha256WebCrypto(body) };
    }
    case "content_hash":
      return { ...checkpoint, contentHash: "f".repeat(64) };
    case "segment_hash":
      return { ...checkpoint, segmentHash: "e".repeat(64) };
    case "revision":
      return { ...checkpoint, revision: checkpoint.revision + 1 };
  }
}

describe("readDocumentAtRevision against the full record", () => {
  test.prop([record, fc.nat(), fc.nat(), damage, text], { numRuns: 60 })(
    "a read from any checkpoint gives the bytes of the full replay",
    async (texts, revisionSeed, checkpointSeed, how, flip) => {
      const built = await buildRecord(texts);
      const start = canonical(EMPTY);
      const revision = revisionSeed % (texts.length + 1);
      const at = 1 + (checkpointSeed % texts.length);
      const made = await buildReconstructionCheckpoints({
        initialDocument: start,
        segments: built.segments,
        revisions: [at],
        replayer,
      });
      if (!made.ok) throw new Error("the invented record must replay");
      const checkpoint = await damaged(made.checkpoints[0]!, how, flip);

      const full = await readDocumentAtRevision({
        initialDocument: start,
        segments: built.segments,
        revision,
        replayer,
        checkpoint: null,
      });
      const fromCheckpoint = await readDocumentAtRevision({
        initialDocument: start,
        segments: built.segments,
        revision,
        replayer,
        checkpoint,
      });

      expect(full.ok).toBe(true);
      expect(fromCheckpoint.ok).toBe(true);
      if (!full.ok || !fromCheckpoint.ok) return;
      expect(fromCheckpoint.canonicalDocument).toBe(full.canonicalDocument);
      expect(fromCheckpoint.documentSha256).toBe(full.documentSha256);
      // A checkpoint is used only when intact and at or before the revision.
      const usable = how === "none" && at <= revision;
      expect(fromCheckpoint.source).toBe(usable ? "checkpoint" : "full");
      if (!usable) expect(fromCheckpoint.fallback).not.toBeNull();
    },
  );
});
