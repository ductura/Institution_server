import { readFileSync } from "node:fs";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import type { EvidenceSegment } from "../../domain/index.ts";
import {
  createDatabases,
  createLayers,
  createProcessSummaryDetailsRouteFor,
  startServer,
  type Running,
} from "../../http/index.ts";

const ORIGIN = "https://ductura.example.invalid";
const INSTITUTION = "00000000-0000-4000-8000-000000000001";
const PACKAGE = "demo-paket";
const owner = "a".repeat(43);
const teacher = "b".repeat(43);
const stranger = "c".repeat(43);
const expired = "d".repeat(43);
const vectors = JSON.parse(
  readFileSync(
    new URL("../../domain/forensics/golden-vectors/evidence-v4.json", import.meta.url),
    "utf8",
  ),
) as {
  accepted: { name: string; canonical: string; segmentHash: string; segment: EvidenceSegment }[];
};
const {
  canonical: payload,
  segmentHash: hash,
  segment,
} = vectors.accepted.find(({ name }) => name === "v4-ai-transfer")!;
const { documentId: DOC, observedStartedAt: from, observedEndedAt: to } = segment;
let server: Running;
const readImmutable = vi.fn(async () => ({
  status: "found" as const,
  bytes: Buffer.from(payload),
}));
const withActor: WithActor = async (token, read) => {
  if (token === expired) throw Object.assign(new Error("expired"), { code: "ZD401" });
  return read({
    async query<Row>(sql: string, parameters?: readonly unknown[]) {
      expect(sql).toContain("app.read_process_summary_source($1)");
      const row =
        parameters?.[0] === DOC && (token === owner || token === teacher)
          ? Object.fromEntries([
              ["outcome", "found"],
              ["institution_id", INSTITUTION],
              ["evidence_package_id", PACKAGE],
              ["segment_hashes", [hash]],
            ])
          : { outcome: "not_found" };
      return { rows: [row as Row], rowCount: 1 };
    },
  });
};

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [
      createProcessSummaryDetailsRouteFor({ withActor }, { payloads: { readImmutable } }, {}),
    ],
  });
});
afterAll(async () => {
  await server?.close();
});

function post(token?: string, body: unknown = { documentId: DOC }) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/process-summary/details`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(token === undefined ? {} : { cookie: `__Host-ductus_session=${token}` }),
    },
    body: JSON.stringify(body),
  });
}

it("returns the same verified summary to the owner and teacher, without text or source identifiers", async () => {
  const ownerAnswer = await post(owner);
  const teacherAnswer = await post(teacher);
  expect([ownerAnswer.status, teacherAnswer.status]).toEqual([200, 200]);
  expect(teacherAnswer.headers.get("cache-control")).toBe("no-store");
  const body = await teacherAnswer.text();
  expect(body).toBe(await ownerAnswer.text());
  expect(JSON.parse(body)).toMatchObject({
    summary: { sessions: { count: 1 } },
    activeEditingMinutes: 1,
    keyEvents: [{ kind: "ai-transfer", at: { from, to } }],
  });
  expect(body).not.toContain("00000000-0000-4000-8000-0000000000a2");
  expect(body).not.toContain("Lorem odlomak 2");
  expect(readImmutable).toHaveBeenLastCalledWith({
    institutionId: INSTITUTION,
    evidencePackageId: PACKAGE,
    segmentHash: hash,
  });
});

it("returns the same 404 for a refused work and a missing one, before accessing storage", async () => {
  readImmutable.mockClear();
  for (const response of [
    await post(stranger),
    await post(owner, { documentId: "demo-nepostojeci" }),
  ]) {
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  }
  expect((await post()).status).toBe(401);
  expect((await post(expired)).status).toBe(401);
  expect((await post(owner, { documentId: DOC, role: "teacher" })).status).toBe(422);
  expect(readImmutable).not.toHaveBeenCalled();
});

it("refuses an unverifiable stored record as a whole", async () => {
  readImmutable.mockResolvedValueOnce({ status: "found", bytes: Buffer.from("{}") });
  const response = await post(teacher);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});
