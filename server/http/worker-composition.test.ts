// The composition of the worker process (F4-PM2-R01B): one pool, three
// workers, each of which registers and takes up one record of its own queue.
// The database is a fake that answers by the RPC a statement names; nothing
// here is a real person, document or key.
import { describe, expect, it, vi } from "vitest";

import { InMemoryEvidencePayloadStore } from "../external/storage/index.ts";
import type { LogLevel } from "../log/index.ts";

import {
  createWorkerProcess,
  WORKER_EVIDENCE_DOMAIN_VARIABLE,
  workerEnvironmentProblems,
} from "./worker-composition.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const INSTITUTION = "00000000-0000-4000-8000-0000000000a1";
const RECEIPT = "00000000-0000-4000-8000-0000000000b1";
const SUBMISSION = "00000000-0000-4000-8000-0000000000c1";
const ENV = {
  WORKER_DATABASE_URL: "postgres://worker:izmisljeno@localhost:5432/ductus",
  [WORKER_EVIDENCE_DOMAIN_VARIABLE]: DOMAIN,
};

/** A row under the database's own column names, which the lint keeps out of code written as properties. */
const columns = (...entries: [string, string][]): Record<string, string> =>
  Object.fromEntries(entries);

type Statement = { text: string; values: unknown[] };

/** A database with one record in each worker's queue and nothing behind it. */
function fakeDatabase() {
  const statements: Statement[] = [];
  const database = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      const rows = (): unknown[] => {
        if (text.includes("worker_pending_backlog"))
          return [
            columns(
              ["evidence_domain_id", DOMAIN],
              ["pending_count", "1"],
              ["oldest_created_at", "2026-11-27T10:00:00.000Z"],
            ),
          ];
        if (text.includes("worker_pending_receipts"))
          return [columns(["receipt_id", RECEIPT], ["receipt_payload", "izmisljena-potvrda"])];
        if (text.includes("worker_packages_due_checkpoints"))
          return [{ evidencePackageId: "pkg-a", institutionId: INSTITUTION, segmentCount: "50" }];
        if (text.includes("worker_submissions_to_reconstruct"))
          return [{ submissionId: SUBMISSION }];
        return [];
      };
      return { rows: rows() };
    }),
  };
  return { database, statements };
}

function build(extra: { closeDatabase?: () => Promise<void> } = {}) {
  const { database, statements } = fakeDatabase();
  const lines: { level: LogLevel; event: string; fields: Record<string, unknown> | undefined }[] =
    [];
  const sign = vi.fn();
  const process = createWorkerProcess(ENV, "/nonexistent", {
    database: database as never,
    evidence: {
      signer: { sign } as never,
      payloads: Object.assign(new InMemoryEvidencePayloadStore(), {
        headImmutable: async () => ({ status: "unavailable", reason: "test" }) as const,
      }) as never,
    },
    log: (level, event, fields) => lines.push({ level, event, fields }),
    closeDatabase: extra.closeDatabase ?? (async () => undefined),
  });
  return { process, database, statements, lines };
}

describe("workerEnvironmentProblems", () => {
  it("is empty for a good configuration", () => {
    expect(workerEnvironmentProblems(ENV)).toEqual([]);
  });

  it.each([
    [{}, 2],
    [{ ...ENV, WORKER_DATABASE_URL: "  " }, 1],
    [{ ...ENV, [WORKER_EVIDENCE_DOMAIN_VARIABLE]: "nije-uuid" }, 1],
  ])("names the variable and never its value (%#)", (env, count) => {
    const problems = workerEnvironmentProblems(env);
    expect(problems).toHaveLength(count);
    expect(JSON.stringify(problems)).not.toContain("izmisljeno");
    expect(JSON.stringify(problems)).not.toContain("nije-uuid");
  });

  it("a bad configuration builds no worker", () => {
    expect(() => createWorkerProcess({}, "/nonexistent")).toThrow("worker configuration invalid");
  });
});

describe("createWorkerProcess", () => {
  it("registers all three workers over the one database and each takes up its record", async () => {
    const { process, statements, lines } = build();
    await Promise.all([
      process.signing.runPass(),
      process.reconstruction.runPass(),
      process.verdict.runPass(),
    ]);
    const asked = (rpc: string) => statements.filter((s) => s.text.includes(rpc));

    // Signing read the one pending receipt of the configured domain.
    expect(asked("worker_pending_receipts")[0]?.values[0]).toBe(DOMAIN);
    expect(lines.find((l) => l.event === "worker.receipt_signing.pass")?.fields).toMatchObject({
      pendingReceipts: 1,
    });
    // Reconstruction listed the due package and went on to read its chain.
    expect(asked("worker_package_chain")[0]?.values).toEqual([DOMAIN, "pkg-a"]);
    expect(
      lines.find((l) => l.event === "worker.reconstruction_checkpoints.pass")?.fields,
    ).toMatchObject({ packages: 1 });
    // The verdict worker listed the submission and went on to read its record.
    expect(asked("worker_submission_record")[0]?.values).toEqual([DOMAIN, SUBMISSION]);
    expect(lines.find((l) => l.event === "worker.submission_verdict.pass")?.fields).toMatchObject({
      listed: 1,
    });
  });

  it("start runs a pass of every worker at once and stop ends them and closes the database once", async () => {
    const closeDatabase = vi.fn(async () => undefined);
    const { process, lines } = build({ closeDatabase });
    process.start();
    await vi.waitFor(() => {
      for (const event of [
        "worker.receipt_signing.pass",
        "worker.reconstruction_checkpoints.pass",
        "worker.submission_verdict.pass",
      ])
        expect(lines.some((l) => l.event === event)).toBe(true);
    });
    await Promise.all([process.stop(), process.stop()]);
    expect(closeDatabase).toHaveBeenCalledOnce();
    // After stop no pass starts.
    expect(await process.signing.runPass()).toBeNull();
    expect(await process.reconstruction.runPass()).toBeNull();
    expect(await process.verdict.runPass()).toBeNull();
  });

  it("writes no id, text or key into a log line", async () => {
    const { process, lines } = build();
    await process.signing.runPass();
    await process.reconstruction.runPass();
    await process.verdict.runPass();
    const written = JSON.stringify(lines);
    for (const secret of [RECEIPT, SUBMISSION, INSTITUTION, "izmisljena-potvrda", "pkg-a"])
      expect(written).not.toContain(secret);
  });
});
