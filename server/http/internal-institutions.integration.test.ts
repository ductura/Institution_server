// Provisioning of an institution instance (contract Ductus#2028 c.6993786629
// §2) on a real server with the real pipeline, over a fake port: every answer
// of §2, the token rules and the body rules. The server-to-server POST sends
// no Origin and must pass the pipeline. Every value is invented.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  InstitutionProvisioning,
  InstitutionProvisionInput,
  InstitutionProvisionOutcome,
  ProvisionedInstitution,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInternalInstitutionRoutes } from "./internal-institutions.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const TOKEN = "izmisljeni-token-za-provisioning-0123456789abcdef";
const ORIGIN = "https://ductura.example.invalid";
const PATH = "/internal/v1/institutions";
const BODY = {
  slug: "fpzg-test",
  displayName: "Fakultet (test)",
  aaiHomeOrg: "fpzg-test.example",
  oidcIssuer: "http://localhost:8090",
  seats: { student: 200, teacher: 50, network_engineer: 3, institution_admin: 1 },
};
const ID = "00000000-0000-4000-8000-00000000a001";
const INSTANCE: ProvisionedInstitution = {
  institutionId: ID,
  slug: BODY.slug,
  displayName: BODY.displayName,
  aaiHomeOrg: BODY.aaiHomeOrg,
  oidcIssuer: BODY.oidcIssuer,
  seats: BODY.seats,
};

let server: Running | undefined;
const calls = { provision: [] as InstitutionProvisionInput[], read: [] as string[] };
let outcome: () => Promise<InstitutionProvisionOutcome>;
let found: () => Promise<ProvisionedInstitution | null>;

async function start(
  env: Record<string, string | undefined> = { DUCTURA_PROVISIONING_TOKEN: TOKEN },
) {
  outcome = async () => ({ outcome: "created", institutionId: ID });
  found = async () => INSTANCE;
  const provisioning: InstitutionProvisioning = {
    provision: async (input) => {
      calls.provision.push(input);
      return outcome();
    },
    read: async (slug) => {
      calls.read.push(slug);
      return found();
    },
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInternalInstitutionRoutes({ env, provisioning, timeoutMs: 300 }),
  });
}
afterEach(async () => {
  calls.provision.length = 0;
  calls.read.length = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

type Answer = { status: number; type: string | undefined; body: string };
function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, method, path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"], body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const post = (body: unknown, headers: Record<string, string> = auth()) =>
  send(
    "POST",
    PATH,
    { "content-type": "application/json", ...headers },
    typeof body === "string" ? body : JSON.stringify(body),
  );
const get = (slug: string, headers: Record<string, string> = auth()) =>
  send("GET", `${PATH}/${slug}`, headers);
const json = (answer: Answer) => JSON.parse(answer.body) as unknown;

describe("POST /internal/v1/institutions", () => {
  it("201 for a new institution, without Origin, with the checked input", async () => {
    await start();
    const answer = await post(BODY);
    expect(answer.status).toBe(201);
    expect(json(answer)).toEqual({ institutionId: ID, slug: "fpzg-test", status: "aktivna" });
    expect(calls.provision).toEqual([BODY]);
  });

  it("200 with the same body when the institution already exists with the same data", async () => {
    await start();
    outcome = async () => ({ outcome: "existing", institutionId: ID });
    const answer = await post(BODY);
    expect(answer.status).toBe(200);
    expect(json(answer)).toEqual({ institutionId: ID, slug: "fpzg-test", status: "aktivna" });
  });

  it("409 slug_zauzet and domena_zauzeta", async () => {
    await start();
    outcome = async () => ({ outcome: "slug_taken" });
    let answer = await post(BODY);
    expect([answer.status, json(answer)]).toEqual([409, { greska: "slug_zauzet" }]);
    outcome = async () => ({ outcome: "domain_taken" });
    answer = await post(BODY);
    expect([answer.status, json(answer)]).toEqual([409, { greska: "domena_zauzeta" }]);
  });

  it("400 for a display name only the database refuses", async () => {
    await start();
    outcome = async () => ({ outcome: "invalid" });
    const answer = await post(BODY);
    expect([answer.status, json(answer)]).toEqual([
      400,
      { greska: "neispravan_unos", polje: "displayName" },
    ]);
  });

  it.each([
    ["an unknown field", { ...BODY, extra: 1 }, "extra"],
    ["a missing slug", { ...BODY, slug: undefined }, "slug"],
    ["an upper-case slug", { ...BODY, slug: "FPZG" }, "slug"],
    ["a too long slug", { ...BODY, slug: "a".repeat(33) }, "slug"],
    ["an empty display name", { ...BODY, displayName: "  " }, "displayName"],
    ["a display name with a control", { ...BODY, displayName: "a\u0007b" }, "displayName"],
    ["a too long display name", { ...BODY, displayName: "a".repeat(201) }, "displayName"],
    ["a home organisation without a dot", { ...BODY, aaiHomeOrg: "fpzg" }, "aaiHomeOrg"],
    ["an upper-case home organisation", { ...BODY, aaiHomeOrg: "FPZG.example" }, "aaiHomeOrg"],
    ["an issuer that is not http(s)", { ...BODY, oidcIssuer: "ftp://idp.example" }, "oidcIssuer"],
    [
      "an issuer with a trailing slash",
      { ...BODY, oidcIssuer: "http://localhost:8090/" },
      "oidcIssuer",
    ],
    ["an issuer in upper case", { ...BODY, oidcIssuer: "http://LOCALHOST:8090" }, "oidcIssuer"],
    ["seats that are not an object", { ...BODY, seats: [1, 2, 3, 4] }, "seats"],
    ["an unknown seat role", { ...BODY, seats: { ...BODY.seats, guest: 1 } }, "seats"],
    [
      "a missing seat role",
      { ...BODY, seats: { ...BODY.seats, teacher: undefined } },
      "seats.teacher",
    ],
    ["negative seats", { ...BODY, seats: { ...BODY.seats, student: -1 } }, "seats.student"],
    ["fractional seats", { ...BODY, seats: { ...BODY.seats, student: 1.5 } }, "seats.student"],
    [
      "seats over the limit",
      { ...BODY, seats: { ...BODY.seats, institution_admin: 1_000_001 } },
      "seats.institution_admin",
    ],
    ["an array body", [BODY], "tijelo"],
  ])("400 for %s, without calling the port", async (_name, body, polje) => {
    await start();
    const answer = await post(body);
    expect([answer.status, json(answer)]).toEqual([400, { greska: "neispravan_unos", polje }]);
    expect(calls.provision).toEqual([]);
  });

  it("400 tijelo for invalid JSON, another media type and a body over 4 KB", async () => {
    await start();
    for (const answer of [
      await post("{"),
      await send("POST", PATH, { ...auth(), "content-type": "text/plain" }, JSON.stringify(BODY)),
      await post({ ...BODY, displayName: "a".repeat(4200) }),
    ]) {
      expect([answer.status, json(answer)]).toEqual([
        400,
        { greska: "neispravan_unos", polje: "tijelo" },
      ]);
    }
    expect(calls.provision).toEqual([]);
  });

  it("401 without the token, with a wrong one, another scheme or two headers", async () => {
    await start();
    for (const headers of [
      {},
      auth(`${TOKEN}x`),
      auth(TOKEN.slice(1)),
      { authorization: `Basic ${TOKEN}` },
      { authorization: `bearer ${TOKEN}` },
    ]) {
      const answer = await post(BODY, headers);
      expect(answer.status).toBe(401);
      expect(answer.body).toBe("");
    }
    expect(calls.provision).toEqual([]);
  });

  it("503 with no body when the database fails", async () => {
    await start();
    vi.spyOn(console, "error").mockImplementation(() => {});
    outcome = async () => {
      throw Object.assign(new Error("down"), { code: "08006" });
    };
    const answer = await post(BODY);
    expect([answer.status, answer.body]).toEqual([503, ""]);
  });
});

describe("GET /internal/v1/institutions/{slug}", () => {
  it("200 with the instance", async () => {
    await start();
    const answer = await get("fpzg-test");
    expect(answer.status).toBe(200);
    expect(json(answer)).toEqual({ ...INSTANCE, status: "aktivna" });
    expect(calls.read).toEqual(["fpzg-test"]);
  });

  it("404 for an unknown or malformed slug, 401 without the token", async () => {
    await start();
    found = async () => null;
    expect((await get("nepostojeca")).status).toBe(404);
    expect((await get("Ne%20slug")).status).toBe(404);
    expect(calls.read).toEqual(["nepostojeca"]);
    const answer = await get("fpzg-test", {});
    expect([answer.status, answer.body]).toEqual([401, ""]);
  });
});

describe("without a token in the environment", () => {
  it.each([
    ["unset", {}],
    ["shorter than 32 characters", { DUCTURA_PROVISIONING_TOKEN: "kratki-token" }],
  ])("both routes answer 404 when the token is %s", async (_name, env) => {
    await start(env);
    expect((await post(BODY, auth("kratki-token"))).status).toBe(404);
    expect((await get("fpzg-test", auth("kratki-token"))).status).toBe(404);
    expect(calls.provision).toEqual([]);
    expect(calls.read).toEqual([]);
  });
});
