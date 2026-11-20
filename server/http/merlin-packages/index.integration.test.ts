// POST /api/v1/teacher/assignments/{assignmentId}/merlin/packages and the
// state and download of a package (SRV-1110) on a real server with the real
// pipeline. First the vectors of the three contracts over a fake service;
// then the whole way over the real service and ZIP builder with an
// in-memory port that keeps the rules of the database (the same key is the
// same package, only the one who asked, 24 hours, a record per download),
// reading the downloaded ZIP back. All values are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type {
  MerlinPackageDownload,
  MerlinPackageRead,
  MerlinPackageRequest,
  MerlinPackageStatus,
} from "../../database/index.ts";
import {
  createMerlinPackageService,
  createMerlinRosterReader,
  merlinRosterCsv,
  MERLIN_PACKAGE_CSV,
  MERLIN_PACKAGE_FINGERPRINTS,
  type MerlinPackageService,
  type MerlinPackageServiceDeps,
  type MerlinRosterDeps,
  type MerlinRosterRead,
} from "../../downloads/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";
import { MERLIN_LABELS } from "../merlin-roster/index.ts";

import { createMerlinPackageRoutes, MERLIN_PACKAGE_FILENAME } from "./index.ts";

type Vector = {
  name: string;
  code?: string;
  request: {
    params: { assignmentId: string; packageId?: string };
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; headers?: Record<string, string>; body?: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const ORIGIN = "https://ductura.example.invalid";
const A = "00000000-0000-4000-8000-0000000000a1";
const P = "00000000-0000-4000-8000-0000000000b1";
const COOKIE = "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000001";
const OTHER = "__Host-ductus_session=izmisljeni-token-nastavnika-000000000000002";
const KEY = "4b1e2c3d-0000-4000-8000-00000000aaa1";

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function start(service: MerlinPackageService): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createMerlinPackageRoutes(service),
  });
  return `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${A}/merlin/packages`;
}

const unexpected = () => Promise.reject(new Error("izmisljena greska"));
/** A service whose every call answers `answer`. */
function fixed(answer: () => Promise<unknown>): MerlinPackageService {
  return {
    request: answer as MerlinPackageService["request"],
    status: answer as MerlinPackageService["status"],
    download: answer as MerlinPackageService["download"],
  };
}
const refusalFor = (status: number) =>
  status === 401
    ? { status: "unauthorized" }
    : status === 422
      ? { status: "invalid_input" }
      : { status: "not_found" };

async function expectError(got: Response, v: Vector) {
  expect(got.status).toBe(v.response.status);
  expect(await got.json()).toEqual({
    ...v.response.body,
    requestId: got.headers.get("x-request-id"),
  });
}

describe("teacher.merlin-packages.post", () => {
  const vectors = vectorsOf("teacher.merlin-packages.post").filter(
    (v) => v.request.headers?.["content-length"] === undefined,
  );
  it.each(vectors.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
    const base = await start(
      fixed(async () =>
        v.response.status === 503
          ? unexpected()
          : v.response.status === 202
            ? { status: "accepted", ...v.response.body }
            : refusalFor(v.response.status),
      ),
    );
    const got = await fetch(base.replace(A, v.request.params.assignmentId), {
      method: "POST",
      headers: v.request.headers ?? {},
      body: v.request.rawBody ?? JSON.stringify(v.request.body),
    });
    if (v.response.status !== 202) return expectError(got, v);
    expect(got.status).toBe(202);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toEqual(v.response.body);
  });
});

describe("teacher.merlin-package.get", () => {
  it.each(vectorsOf("teacher.merlin-package.get").map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      const body = v.response.body as Partial<MerlinPackageStatus> | undefined;
      const base = await start(
        fixed(async () =>
          v.response.status === 503
            ? unexpected()
            : v.response.status === 200
              ? {
                  status: "read",
                  package: {
                    id: body!.id,
                    state: body!.state,
                    sha256: body!.sha256 ?? null,
                    byteSize: body!.sha256 === undefined ? null : 44,
                    expiresAt: body!.expiresAt ?? null,
                  },
                }
              : refusalFor(v.response.status),
        ),
      );
      const { assignmentId, packageId } = v.request.params;
      const got = await fetch(
        `${base.replace(A, assignmentId)}/${packageId}`,
        v.request.headers === undefined ? {} : { headers: v.request.headers },
      );
      if (v.response.status !== 200) return expectError(got, v);
      expect(got.status).toBe(200);
      expect(await got.json()).toEqual(v.response.body);
    },
  );
});

describe("teacher.merlin-package-download.get", () => {
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9]);
  const SHA = createHash("sha256").update(ZIP).digest("hex");
  it.each(vectorsOf("teacher.merlin-package-download.get").map((v) => [v.name, v] as const))(
    "vector %s",
    async (_name, v) => {
      const outcome: Record<number, () => Promise<MerlinPackageDownload>> = {
        200: async () => ({ status: "downloaded", content: ZIP, sha256: SHA }),
        409: async () => ({ status: "not_ready" }),
        410: async () => ({ status: "expired" }),
        503: unexpected,
      };
      const base = await start(
        fixed(outcome[v.response.status] ?? (async () => refusalFor(v.response.status))),
      );
      const { assignmentId, packageId } = v.request.params;
      const got = await fetch(
        `${base.replace(A, assignmentId)}/${packageId}/download`,
        v.request.headers === undefined ? {} : { headers: v.request.headers },
      );
      if (v.response.status !== 200) return expectError(got, v);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("application/zip");
      expect(got.headers.get("content-disposition")).toBe(
        `attachment; filename="${MERLIN_PACKAGE_FILENAME}"`,
      );
      expect(got.headers.get("cache-control")).toBe("no-store");
      expect(got.headers.get("x-content-sha256")).toBe(SHA);
      expect(Buffer.from(await got.arrayBuffer()).equals(ZIP)).toBe(true);
    },
  );

  it("never hands out bytes that are not their fingerprint", async () => {
    const base = await start(
      fixed(async () => ({ status: "downloaded", content: ZIP, sha256: "0".repeat(64) })),
    );
    const got = await fetch(`${base}/${P}/download`, { headers: { cookie: COOKIE } });
    expect(got.status).toBe(503);
  });
});

/** The rules of the database, in memory, with a clock the test moves. */
function memoryPort(clock: { now: number }) {
  type Row = {
    id: string;
    owner: string;
    key: string;
    state: "queued" | "ready" | "failed";
    content?: Uint8Array;
    sha256?: string;
    expiresAt?: number;
  };
  const rows: Row[] = [];
  const downloads: { id: string; owner: string; sha256: string }[] = [];
  const own = (token: string, assignmentId: string, id: string) =>
    assignmentId === A ? rows.find((r) => r.id === id && r.owner === token) : undefined;
  const statusOf = (r: Row): MerlinPackageStatus => {
    const built = r.state === "ready";
    const expired = built && clock.now >= r.expiresAt!;
    return {
      id: r.id,
      state: expired ? "expired" : r.state,
      sha256: built ? r.sha256! : null,
      byteSize: built ? r.content!.byteLength : null,
      expiresAt: built ? new Date(r.expiresAt!).toISOString() : null,
    };
  };
  const packages: MerlinPackageServiceDeps["packages"] = {
    async request(token, assignmentId, key): Promise<MerlinPackageRequest> {
      if (assignmentId !== A) return { status: "not_found" };
      const found = rows.find((r) => r.owner === token && r.key === key);
      if (found !== undefined) {
        return { status: "requested", id: found.id, state: statusOf(found).state, claimed: false };
      }
      const id = `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      rows.push({ id, owner: token, key, state: "queued" });
      return { status: "requested", id, state: "queued", claimed: true };
    },
    async complete(token, assignmentId, id, content, sha256, studentIds) {
      expect(studentIds).toEqual(["00000000-0000-4000-8000-0000000000e1"]);
      const r = own(token, assignmentId, id);
      if (r === undefined) return { status: "not_found" };
      if (createHash("sha256").update(content).digest("hex") !== sha256) throw new Error("otisak");
      Object.assign(r, { state: "ready", content, sha256, expiresAt: clock.now + 24 * 3_600_000 });
      return { status: "written", package: statusOf(r) };
    },
    async fail() {
      throw new Error("not expected");
    },
    async status(token, assignmentId, id): Promise<MerlinPackageRead> {
      const r = own(token, assignmentId, id);
      return r === undefined ? { status: "not_found" } : { status: "read", package: statusOf(r) };
    },
    async download(token, assignmentId, id): Promise<MerlinPackageDownload> {
      const r = own(token, assignmentId, id);
      if (r === undefined) return { status: "not_found" };
      if (r.state !== "ready") return { status: "not_ready" };
      if (clock.now >= r.expiresAt!) return { status: "expired" };
      downloads.push({ id, owner: token, sha256: r.sha256! });
      return { status: "downloaded", content: r.content!, sha256: r.sha256! };
    },
  };
  return { packages, downloads };
}

function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buffer = Buffer.from(bytes);
  const out = new Map<string, Buffer>();
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    const size = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt16LE(at + 26);
    const start = at + 30 + nameLength + buffer.readUInt16LE(at + 28);
    out.set(
      buffer.subarray(at + 30, at + 30 + nameLength).toString("utf8"),
      buffer.subarray(start, start + size),
    );
    at = start + size;
  }
  return out;
}

describe("the whole way over the real service", () => {
  // The JCS of a v1 document with one paragraph (keys in order, as canonicalizeJcs writes them).
  const document = JSON.stringify({
    nodes: [
      {
        children: [{ marks: [], text: "Izmišljeni rad o kompostu", type: "text" }],
        id: "00000000-0000-4000-8000-000000000001",
        type: "paragraph",
      },
    ],
    schemaVersion: 1,
  });
  const S = "00000000-0000-4000-8000-0000000000e1";
  const rosterReader = createMerlinRosterReader({
    extensions: async () => ({ status: "read", extensions: [] }),
    submissions: (async () => ({
      status: "ok",
      submissions: new Map([
        [
          A,
          [
            {
              studentId: S,
              submitted: true,
              revision: 3,
              requestedMinute: "2026-12-20T21:14:00.000Z",
              afterDeadline: false,
            },
          ],
        ],
      ]),
    })) as unknown as MerlinRosterDeps["submissions"],
    works: async () => ({
      status: "read",
      students: [
        {
          studentId: S,
          givenName: "Demo",
          familyName: "Anić",
          work: { documentId: "rad-1", submitted: true, revision: 3, body: document },
        },
      ],
    }),
    labels: MERLIN_LABELS,
  });
  const rosterRead = () => rosterReader("izmisljeni-token-nastavnika-000000000000001", A);

  it("asks once per key, names the ZIP's fingerprint, hands out the same bytes and expires after 24 hours", async () => {
    const clock = { now: Date.parse("2026-11-21T09:15:00.000Z") };
    const memory = memoryPort(clock);
    let built = 0;
    const base = await start(
      createMerlinPackageService({
        packages: memory.packages,
        roster: async (token) => {
          expect(token).toBe("izmisljeni-token-nastavnika-000000000000001");
          built += 1;
          return rosterRead();
        },
        labels: MERLIN_LABELS,
      }),
    );
    const post = () =>
      fetch(base, {
        method: "POST",
        headers: {
          cookie: COOKIE,
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify({ requestKey: KEY }),
      });
    const first = await post();
    expect(first.status).toBe(202);
    const asked = (await first.json()) as { id: string; state: string };
    expect(asked.state).toBe("ready");
    // The same key again: the same package, not built a second time.
    expect(await (await post()).json()).toEqual(asked);
    expect(built).toBe(1);

    const state = (await (
      await fetch(`${base}/${asked.id}`, { headers: { cookie: COOKIE } })
    ).json()) as {
      state: string;
      downloadPath: string;
      expiresAt: string;
      sha256: string;
    };
    expect(state).toMatchObject({
      id: asked.id,
      state: "ready",
      expiresAt: "2026-11-22T09:15:00.000Z",
    });
    const origin = new URL(base).origin;
    const download = await fetch(`${origin}${state.downloadPath}`, { headers: { cookie: COOKIE } });
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(state.sha256);
    expect(download.headers.get("x-content-sha256")).toBe(state.sha256);
    expect(memory.downloads).toEqual([
      { id: asked.id, owner: expect.any(String), sha256: state.sha256 },
    ]);

    // The ZIP: CSV, PDF, DOCX and otisci.sha256, all from the same bytes.
    const files = readZip(bytes);
    expect([...files.keys()]).toEqual([
      MERLIN_PACKAGE_CSV,
      "anic-demo-00000000.pdf",
      "anic-demo-00000000.docx",
      MERLIN_PACKAGE_FINGERPRINTS,
    ]);
    const sha = (name: string) => createHash("sha256").update(files.get(name)!).digest("hex");
    const csv = files.get(MERLIN_PACKAGE_CSV)!.toString("utf8");
    const { roster } = (await rosterRead()) as Extract<MerlinRosterRead, { status: "read" }>;
    expect(csv).toBe(merlinRosterCsv(roster.rows, MERLIN_LABELS));
    expect(csv).toContain(`anic-demo-00000000.pdf,${sha("anic-demo-00000000.pdf")}`);
    expect(csv).toContain(`anic-demo-00000000.docx,${sha("anic-demo-00000000.docx")}`);
    expect(files.get(MERLIN_PACKAGE_FINGERPRINTS)!.toString("utf8")).toBe(
      [MERLIN_PACKAGE_CSV, "anic-demo-00000000.pdf", "anic-demo-00000000.docx"]
        .map((name) => `${sha(name)}  ${name}\n`)
        .join(""),
    );

    // Another teacher reads and downloads nothing, and nothing is recorded.
    expect((await fetch(`${base}/${asked.id}`, { headers: { cookie: OTHER } })).status).toBe(404);
    expect(
      (await fetch(`${origin}${state.downloadPath}`, { headers: { cookie: OTHER } })).status,
    ).toBe(404);
    expect(memory.downloads).toHaveLength(1);

    // 24 hours after the build the link has expired.
    clock.now += 24 * 3_600_000;
    expect(
      await (await fetch(`${base}/${asked.id}`, { headers: { cookie: COOKIE } })).json(),
    ).toEqual({
      id: asked.id,
      state: "expired",
      expiresAt: state.expiresAt,
      sha256: state.sha256,
    });
    const late = await fetch(`${origin}${state.downloadPath}`, { headers: { cookie: COOKIE } });
    expect(late.status).toBe(410);
    expect(memory.downloads).toHaveLength(1);
  });
});
