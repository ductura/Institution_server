// GET /api/v1/works/{documentId}/export-slides over a fake withActor, a fake image
// store and a fake converter: the cookie, the work id, the closed query, the one
// statement and its parameters, the same .pptx bytes for the same version, the PDF
// made from that .pptx, a text work and another's work as the same 404, the images
// the document binds, and every failure as the contract's. Every value is invented.
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";

import { createWorkExportReader, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createWorkExportSlidesRoute, type SlideImageReader } from "./index.ts";

const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "00000000-0000-4000-8000-0000000000e1";
const SAVED = new Date("2026-11-27T22:41:00.000Z");
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body));
  return out;
}
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...chunk("IHDR", new Uint8Array([...u32(2), ...u32(1), 8, 0, 0, 0, 0])),
  ...chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array([0, 128, 128])))),
  ...chunk("IEND", new Uint8Array()),
]);

// The canonical (JCS) text of a document: keys sorted, no space; enough for invented ASCII-keyed data.
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null
      ? `{${Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`)
          .join(",")}}`
      : JSON.stringify(value);

const DECK = {
  documentKind: "slides",
  schemaVersion: 1,
  slides: [
    {
      id: id(1),
      layout: "title",
      blocks: [
        { type: "heading", id: id(10), slot: "title", text: "Demo kompost" },
        { type: "paragraph", id: id(11), slot: "subtitle", text: "Izmišljeni Student" },
      ],
      notes: "Pozdrav.",
    },
  ],
};
const DECK_WITH_IMAGE = {
  documentKind: "slides",
  schemaVersion: 1,
  slides: [
    {
      id: id(2),
      layout: "imageOnly",
      blocks: [
        {
          type: "image",
          id: id(20),
          slot: "image",
          attachmentId: id(21),
          attachmentSha256: sha(PNG),
          alt: "Graf",
        },
      ],
    },
  ],
};
const BODY = canonical(DECK);
const found = (body: string) => ({
  outcome: "found",
  revision: "3",
  kind: "saved",
  body,
  savedAt: SAVED,
});
const TEXT_WORK = JSON.stringify({ schemaVersion: 4, sources: [], nodes: [] });
const SHEET_WORK = JSON.stringify({ schemaVersion: 1, kind: "spreadsheet", sheets: [] });
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n");

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Dependencies = {
  readonly image?: SlideImageReader;
  readonly convert?: ((pptx: Buffer) => Promise<Buffer>) | null;
};

async function serve(answer: object[] | Error, dependencies: Dependencies = {}) {
  const spy = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await spy(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  const convert = vi.fn(dependencies.convert ?? (async () => PDF));
  const image = vi.fn(dependencies.image ?? (async () => null));
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [
      createWorkExportSlidesRoute(
        createWorkExportReader(withActor),
        image,
        dependencies.convert === null ? undefined : convert,
      ),
    ],
  });
  const url = (path = DOCUMENT, search = "?format=pptx") =>
    `http://127.0.0.1:${running!.port}/api/v1/works/${path}/export-slides${search}`;
  return { url, spy, convert, image };
}

const get = (url: string, cookie: string | null = COOKIE) =>
  fetch(url, { headers: cookie === null ? {} : { cookie } });
const problem = async (response: Response) => [
  response.status,
  ((await response.json()) as { error?: unknown }).error,
];

it("answers the .pptx of the saved version with the snapshot hash and the same bytes twice", async () => {
  const { url, spy, convert } = await serve([found(BODY)]);
  const first = await get(url());
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe(PPTX);
  expect(first.headers.get("content-disposition")).toBe('attachment; filename="rad.pptx"');
  expect(first.headers.get("x-export-snapshot-sha256")).toBe(sha(BODY));
  const bytes = Buffer.from(await first.arrayBuffer());
  expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(bytes.toString("latin1")).toContain("Demo kompost");
  const second = await get(url());
  expect(Buffer.from(await second.arrayBuffer()).equals(bytes)).toBe(true);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, null]);
  expect(convert).not.toHaveBeenCalled();
});

it("answers the PDF converted from that .pptx, with the same snapshot hash", async () => {
  const { url, convert } = await serve([found(BODY)]);
  const pptx = await get(url());
  const pptxBytes = Buffer.from(await pptx.arrayBuffer());
  const pdf = await get(url(DOCUMENT, "?format=pdf"));
  expect(pdf.status).toBe(200);
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="rad.pdf"');
  expect(pdf.headers.get("x-export-snapshot-sha256")).toBe(
    pptx.headers.get("x-export-snapshot-sha256"),
  );
  expect(Buffer.from(await pdf.arrayBuffer()).equals(PDF)).toBe(true);
  expect(convert).toHaveBeenCalledTimes(1);
  expect((convert.mock.calls[0]![0] as Buffer).equals(pptxBytes)).toBe(true);
});

it("passes versionId as the revision and refuses a row of another revision", async () => {
  const { url, spy } = await serve([found(BODY)]);
  expect((await get(url(DOCUMENT, "?format=pptx&versionId=3"))).status).toBe(200);
  expect(spy.mock.calls[0]?.[1]).toEqual([DOCUMENT, 3]);
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await problem(await get(url(DOCUMENT, "?format=pptx&versionId=4")))).toEqual([
    503,
    "unavailable",
  ]);
  quiet.mockRestore();
});

it("refuses without a cookie, a bad query and a bad work id before the database", async () => {
  const { url, spy } = await serve([found(BODY)]);
  expect(await problem(await get(url(), null))).toEqual([401, "unauthorized"]);
  for (const search of [
    "",
    "?format=docx",
    "?format=PPTX",
    "?format=pptx&format=pdf",
    "?format=pptx&versionId=0",
    "?format=pptx&versionId=03",
    "?format=pptx&role=teacher",
    "?format=pptx&versionId=1&versionId=2",
    "?versionId=1",
  ]) {
    expect(await problem(await get(url(DOCUMENT, search)))).toEqual([422, "invalid_input"]);
  }
  expect(await problem(await get(url("%20doc")))).toEqual([404, "not_found"]);
  expect(spy).not.toHaveBeenCalled();
});

it("answers a text work, a spreadsheet and another's work as the same 404, for both formats", async () => {
  for (const format of ["pptx", "pdf"]) {
    for (const answer of [[found(TEXT_WORK)], [found(SHEET_WORK)], [{ outcome: "not_found" }]]) {
      await running?.close();
      const { url, convert } = await serve(answer);
      expect(await problem(await get(url(DOCUMENT, `?format=${format}`)))).toEqual([
        404,
        "not_found",
      ]);
      expect(convert).not.toHaveBeenCalled();
    }
  }
});

it("reads each image the document binds once and prints it when its hash matches", async () => {
  const image = vi.fn(async (_token: string, attachmentId: string) =>
    attachmentId === id(21) ? PNG : null,
  );
  const { url } = await serve([found(canonical(DECK_WITH_IMAGE))], { image });
  const response = await get(url());
  expect(response.status).toBe(200);
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(bytes.toString("latin1")).toContain("ppt/media/image1.png");
  expect(image.mock.calls).toEqual([[TOKEN, id(21)]]);
});

it("is a 503 when an image is missing, replaced or is not an image, and says why", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const cases: [SlideImageReader, string][] = [
    [async () => null, "image_missing"],
    [async () => new Uint8Array([...PNG, 0]), "image_hash_mismatch"],
  ];
  for (const [image, reason] of cases) {
    await running?.close();
    const { url } = await serve([found(canonical(DECK_WITH_IMAGE))], { image });
    expect(await problem(await get(url()))).toEqual([503, "unavailable"]);
    expect(quiet.mock.lastCall?.[0]).toContain(`"reason":"${reason}"`);
  }
  quiet.mockRestore();
});

it("does not read an image for a text work", async () => {
  const { url, image } = await serve([found(TEXT_WORK)]);
  await get(url());
  expect(image).not.toHaveBeenCalled();
});

it("tells a missing converter, a timeout and a failed conversion apart in the record, all as 503", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const timeout = Object.assign(new Error("izmišljeno"), { name: "TimeoutError" });
  const cases: [Dependencies, string][] = [
    [{ convert: null }, "pdf_unavailable"],
    [{ convert: async () => Promise.reject(timeout) }, "pdf_timeout"],
    [{ convert: async () => Promise.reject(new Error("izmišljeno")) }, "pdf_failed"],
    [{ convert: async () => Buffer.from("nije pdf") }, "pdf_failed"],
  ];
  for (const [dependencies, reason] of cases) {
    await running?.close();
    const { url } = await serve([found(BODY)], dependencies);
    expect(await problem(await get(url(DOCUMENT, "?format=pdf")))).toEqual([503, "unavailable"]);
    expect(quiet.mock.lastCall?.[0]).toContain(`"reason":"${reason}"`);
    // The .pptx never needs the converter.
    expect((await get(url())).status).toBe(200);
  }
  quiet.mockRestore();
});

it("converts one PDF at a time and answers another meanwhile with a 503", async () => {
  let release: (pdf: Buffer) => void = () => undefined;
  const slow = () => new Promise<Buffer>((resolve) => (release = resolve));
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { url, convert } = await serve([found(BODY)], { convert: slow });
  const first = get(url(DOCUMENT, "?format=pdf"));
  await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(1));
  expect(await problem(await get(url(DOCUMENT, "?format=pdf")))).toEqual([503, "unavailable"]);
  expect(quiet.mock.lastCall?.[0]).toContain('"reason":"pdf_busy"');
  release(PDF);
  expect((await first).status).toBe(200);
  // The slot is free again.
  const next = get(url(DOCUMENT, "?format=pdf"));
  await vi.waitFor(() => expect(convert).toHaveBeenCalledTimes(2));
  release(PDF);
  expect((await next).status).toBe(200);
  quiet.mockRestore();
});

it("answers the database's failures and an unreadable deck as the contract's", async () => {
  const broken = JSON.stringify({ ...DECK, slides: [{ id: "nije-uuid" }] });
  const cases: [object[] | Error, [number, string]][] = [
    [Object.assign(new Error("izmišljeno"), { code: "ZD401" }), [401, "unauthorized"]],
    [new Error("izmišljeno"), [503, "unavailable"]],
    [[], [503, "unavailable"]],
    [[found("nije json")], [503, "unavailable"]],
    [[found(broken)], [503, "unavailable"]],
    [[found(JSON.stringify(DECK, null, 2))], [503, "unavailable"]],
  ];
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  for (const [answer, expected] of cases) {
    await running?.close();
    const { url } = await serve(answer);
    expect(await problem(await get(url()))).toEqual(expected);
  }
  quiet.mockRestore();
});
