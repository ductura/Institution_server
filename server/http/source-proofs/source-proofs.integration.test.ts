// The proofs of a source over HTTP (SRV-1102) on a real server and pipeline,
// with the real port over a fake withActor that keeps the proofs of two
// invented students in memory, as the RPCs would: a proof read back belongs to
// the same source and page, a whole PDF is refused before the database,
// another student's work answers 404. Every value is invented.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSourceProofs, type WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createSourceProofRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const ANA = "A".repeat(43);
const BORIS = "B".repeat(43);
const SIGNED_OUT = "C".repeat(43);
const BROKEN = "D".repeat(43);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const SOURCE = "00000000-0000-4000-8000-00000000c0a1";
const OTHER_SOURCE = "00000000-0000-4000-8000-00000000c0a2";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0d, 0x0a, 0x2d, 0x2d, 0x00, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

type Stored = {
  id: string;
  owner: string;
  source: string;
  page: string;
  note: string | null;
  image: Buffer;
};

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** Ana owns the work and both sources; Boris has no relation to it (ZD403, as the RPC answers). */
async function fixture() {
  const stored: Stored[] = [];
  const spy = vi.fn();
  let next = 0;
  const withActor: WithActor = async (token, run) => {
    if (token === SIGNED_OUT) throw coded("ZD401");
    if (token === BROKEN) throw new Error("baza je pala");
    return run({
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        spy(sql, values);
        const [assignment, source] = values as string[];
        if (token !== ANA || assignment !== ASSIGNMENT || ![SOURCE, OTHER_SOURCE].includes(source!))
          throw coded("ZD403");
        let rows: object[] = [];
        if (sql.includes("institution.add_source_proof(")) {
          next += 1;
          const row: Stored = {
            id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
            owner: token,
            source: source!,
            page: values[2] as string,
            note: values[3] as string | null,
            image: values[4] as Buffer,
          };
          stored.push(row);
          rows = [{ id: row.id, page: row.page, note: row.note }];
        } else if (sql.includes("institution.source_proofs(")) {
          rows = stored
            .filter((s) => s.source === source)
            .map(({ id, page, note }) => ({ id, page, note }));
        } else if (sql.includes("institution.read_source_proof_image(")) {
          const found = stored.find((s) => s.source === source && s.id === values[2]);
          if (found === undefined) throw coded("ZD403");
          rows = [{ image: found.image, sha256: "izmisljeno" }];
        } else {
          rows = [{ touched: true }];
        }
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createSourceProofRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}`;
  const proofs = (source = SOURCE, assignment = ASSIGNMENT) =>
    `${base}/api/v1/student/assignments/${assignment}/sources/${source}/proofs`;
  return { base, proofs, stored, spy, port: createSourceProofs(withActor) };
}

const cookie = (token: string) => `__Host-ductus_session=${token}`;

function form(fields: Record<string, string | Buffer>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") data.append(name, value);
    else data.append(name, new Blob([value], { type: "image/jpeg" }), "isjecak.jpg");
  }
  return data;
}

const post = (url: string, body: FormData | string, token = ANA, headers = {}) =>
  fetch(url, {
    method: "POST",
    headers: { cookie: cookie(token), origin: ORIGIN, ...headers },
    body,
  });

describe("student.source-proofs", () => {
  it("attaches an excerpt and reads it back bound to the same source and page", async () => {
    const { base, proofs } = await fixture();
    const created = await post(
      proofs(),
      form({ image: JPEG, page: "14", note: "Izmišljena\nbilješka." }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const proof = (await created.json()) as Record<string, unknown>;
    const imagePath = `/api/v1/student/assignments/${ASSIGNMENT}/sources/${SOURCE}/proofs/${String(proof.id)}/image`;
    expect(proof).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      page: "14",
      note: "Izmišljena\nbilješka.",
      imagePath,
    });
    expect((await post(proofs(), form({ image: JPEG, page: "xii" }))).status).toBe(201);

    const list = await fetch(proofs(), { headers: { cookie: cookie(ANA) } });
    expect(list.status).toBe(200);
    const read = (await list.json()) as { proofs: Record<string, unknown>[] };
    expect(read.proofs.map(({ page, note }) => [page, note])).toEqual([
      ["14", "Izmišljena\nbilješka."],
      ["xii", null],
    ]);
    expect(read.proofs[0]).toEqual(proof);
    const other = await fetch(proofs(OTHER_SOURCE), { headers: { cookie: cookie(ANA) } });
    expect(await other.json()).toEqual({ proofs: [] });

    const image = await fetch(`${base}${imagePath}`, { headers: { cookie: cookie(ANA) } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("cache-control")).toBe("private, no-store");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer()).equals(JPEG)).toBe(true);
    // The same proof id under another source opens nothing.
    const elsewhere = imagePath.replace(SOURCE, OTHER_SOURCE);
    expect((await fetch(`${base}${elsewhere}`, { headers: { cookie: cookie(ANA) } })).status).toBe(
      404,
    );
  });

  it("refuses a whole PDF, a bad page, an unknown field or a text image with 422, before the database", async () => {
    const { proofs, spy, stored } = await fixture();
    for (const fields of [
      { image: PDF, page: "1" },
      { image: JPEG, page: "" },
      { image: JPEG, page: "x".repeat(31) },
      { image: JPEG, page: "1", chapter: "3" },
      { image: JPEG },
      { page: "1" },
    ]) {
      const answer = await post(proofs(), form(fields));
      expect(answer.status, JSON.stringify(Object.keys(fields))).toBe(422);
      expect(await answer.json()).toMatchObject({ code: "invalid_input" });
    }
    const textImage = new FormData();
    textImage.append("image", "nije datoteka");
    textImage.append("page", "1");
    expect((await post(proofs(), textImage)).status).toBe(422);
    expect(spy).not.toHaveBeenCalled();
    expect(stored).toHaveLength(0);
  });

  it("answers 404 for another student's work, and for a malformed id", async () => {
    const { base, proofs, port } = await fixture();
    await port.add(ANA, {
      assignmentId: ASSIGNMENT,
      sourceId: SOURCE,
      page: "3",
      note: null,
      image: JPEG,
    });
    expect((await post(proofs(), form({ image: JPEG, page: "1" }), BORIS)).status).toBe(404);
    expect((await fetch(proofs(), { headers: { cookie: cookie(BORIS) } })).status).toBe(404);
    const image = `${proofs()}/00000000-0000-4000-8000-000000000001/image`;
    expect((await fetch(image, { headers: { cookie: cookie(BORIS) } })).status).toBe(404);
    expect((await fetch(image, { headers: { cookie: cookie(ANA) } })).status).toBe(200);
    expect((await fetch(proofs("nije-uuid"), { headers: { cookie: cookie(ANA) } })).status).toBe(
      404,
    );
    expect(
      (
        await fetch(
          `${base}/api/v1/student/assignments/${ASSIGNMENT}/sources/${SOURCE}/proofs/x/image`,
          {
            headers: { cookie: cookie(ANA) },
          },
        )
      ).status,
    ).toBe(404);
  });

  it("answers 401 without a live session, 415 for a body that is not multipart and 503 when the database fails", async () => {
    const { proofs } = await fixture();
    expect((await fetch(proofs())).status).toBe(401);
    expect((await fetch(proofs(), { headers: { cookie: cookie(SIGNED_OUT) } })).status).toBe(401);
    expect(
      (
        await fetch(proofs(), {
          method: "POST",
          headers: { origin: ORIGIN },
          // Small: the refusal closes the connection before the body is read.
          body: form({ page: "1" }),
        })
      ).status,
    ).toBe(401);
    const json = await post(proofs(), JSON.stringify({ page: "1" }), ANA, {
      "content-type": "application/json",
    });
    expect(json.status).toBe(415);
    expect((await fetch(proofs(), { headers: { cookie: cookie(BROKEN) } })).status).toBe(503);
    expect((await post(proofs(), form({ image: JPEG, page: "1" }), BROKEN)).status).toBe(503);
  });

  it("refuses a declared body above the limit of the contract before reading it", async () => {
    const { proofs, spy } = await fixture();
    const url = new URL(proofs());
    // Declares one byte over the limit and sends only the start: the refusal comes first.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            cookie: cookie(ANA),
            origin: ORIGIN,
            "content-type": "multipart/form-data; boundary=izmisljena",
            "content-length": "1114113",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write("--izmisljena\r\n");
    });
    expect(status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });
});
