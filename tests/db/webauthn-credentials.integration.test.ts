import { randomBytes, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWebAuthnCredentials, createWithActor } from "../../server/database/index.ts";

// DAN-840-3b (contract Ductus#1836 c.6940273164): the WebAuthn credential port
// over the real driver and the real RPCs. A Buffer reaches bytea, a bigint
// comes back as text and a void RPC as one row, as the unit test assumes.
// Every identifier, token and byte below is random and synthetic.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_URL = process.env.APP_DATABASE_URL ?? "";

const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const people = [randomUUID(), randomUUID()] as const;
const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
const app = new pg.Pool({ connectionString: APP_URL, max: 2 });
const port = createWebAuthnCredentials(createWithActor(app));

beforeAll(async () => {
  await admin.query("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    institution,
    `it-webauthn-port-${suffix}`,
  ]);
  for (const [i, person] of people.entries()) {
    await admin.query(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        person,
        institution,
        `https://issuer-${suffix}.test`,
        `sub-${i}`,
        `engineer-${i}@it.example`,
      ],
    );
    await admin.query(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [tokens[i], person, institution],
    );
  }
});

afterAll(async () => {
  try {
    for (const table of ["webauthn_credential", "session", "user_account"])
      await admin.query(`DELETE FROM identity.${table} WHERE institution_id = $1`, [institution]);
    await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  } finally {
    await app.end();
    await admin.end();
  }
});

describe("the WebAuthn credential port on PostgreSQL", () => {
  const [ana, dora] = tokens as [string, string];
  const credentialId = randomBytes(16);
  const publicKey = randomBytes(77);

  it("adds, lists and uses a key; 0 to 0 and the upper bound pass", async () => {
    expect(await port.list(ana)).toEqual({ status: "listed", credentials: [] });
    expect(await port.add(ana, { credentialId, publicKey, signCount: 0 })).toEqual({
      status: "added",
    });
    expect(await port.list(ana)).toEqual({
      status: "listed",
      credentials: [{ credentialId, publicKey, signCount: 0 }],
    });
    expect(await port.use(ana, credentialId, 0)).toEqual({ status: "used" });
    expect(await port.use(ana, credentialId, 0)).toEqual({ status: "used" });
    expect(await port.use(ana, credentialId, 2 ** 32 - 1)).toEqual({ status: "used" });
    expect(await port.use(ana, credentialId, 2 ** 32 - 1)).toEqual({
      status: "counter_not_increased",
    });
    expect(await port.list(ana)).toEqual({
      status: "listed",
      credentials: [{ credentialId, publicKey, signCount: 2 ** 32 - 1 }],
    });
  });

  it("refuses a second key, a taken id and a foreign key", async () => {
    const other = { credentialId: randomBytes(16), publicKey, signCount: 0 };
    expect(await port.add(ana, other)).toEqual({ status: "forbidden" });
    expect(await port.add(dora, { ...other, credentialId })).toEqual({ status: "conflict" });
    expect(await port.use(dora, credentialId, 1)).toEqual({ status: "forbidden" });
    expect(await port.list(dora)).toEqual({ status: "listed", credentials: [] });
  });

  it("a key revoked between list and use is refused", async () => {
    const listed = await port.list(ana);
    expect(listed.status).toBe("listed");
    await admin.query(
      "UPDATE identity.webauthn_credential SET revoked_at = now() WHERE credential_id = $1",
      [credentialId],
    );
    expect(await port.use(ana, credentialId, 2 ** 32 - 1)).toEqual({ status: "forbidden" });
    expect(await port.list(ana)).toEqual({ status: "listed", credentials: [] });
  });

  it("without a live session every call is unauthenticated", async () => {
    await admin.query(
      "UPDATE identity.session SET closed_at = now(), close_reason = 'logout' WHERE institution_id = $1",
      [institution],
    );
    expect(await port.list(ana)).toEqual({ status: "unauthenticated" });
    expect(await port.add(ana, { credentialId: randomBytes(16), publicKey, signCount: 0 })).toEqual(
      { status: "unauthenticated" },
    );
    expect(await port.use(ana, credentialId, 1)).toEqual({ status: "unauthenticated" });
  });
});
