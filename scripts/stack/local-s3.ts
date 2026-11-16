// DAN-817: the local S3 of the VS-1 stack. Local stack and CI only (D-09,
// F-020): it refuses to start unless NODE_ENV is development or test, listens
// only on 127.0.0.1 and keeps objects as files in one directory, so they
// survive a restart of this process and of the server (VS-1.13). It answers
// only what S3EvidencePayloadStore asks: GET, HEAD and a create-only PUT
// (If-None-Match: *) with the SHA-256 checksum echoed, every request signed
// with SigV4 by the one key of this run. Never part of dist/server.js.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type LocalS3Config = {
  root: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => Date;
};

type Env = Readonly<Record<string, string | undefined>>;

// Larger than any segment the adapter sends; a longer body is refused unread.
export const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/u;
const PATH = /^\/[A-Za-z0-9._/-]{1,1024}$/u;
const AUTH =
  /^AWS4-HMAC-SHA256 Credential=([A-Za-z0-9_-]{1,128})\/(\d{8})\/([a-z0-9-]{1,32})\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]{1,512}), Signature=([0-9a-f]{64})$/u;
const AMZ_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_SKEW_MS = 15 * 60 * 1000;
// Signed on every request, and on a PUT also the two that make it create-only.
const ALWAYS_SIGNED = ["host", "x-amz-content-sha256", "x-amz-date"];
const PUT_SIGNED = ["if-none-match", "x-amz-checksum-sha256"];

const xml = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code></Error>`;

function answer(
  res: ServerResponse,
  status: number,
  code: string | null,
  headers: Record<string, string> = {},
) {
  const body = code === null ? "" : xml(code);
  res.writeHead(status, {
    ...headers,
    ...(code === null ? {} : { "content-type": "application/xml" }),
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

const hmac = (key: Uint8Array | string, value: string) =>
  createHmac("sha256", key).update(value, "utf8").digest();

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function one(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

/** The SigV4 check of one request, before its body is read; a fault names the S3 code. */
function signatureFault(req: IncomingMessage, path: string, config: LocalS3Config): string | null {
  const parts = AUTH.exec(one(req, "authorization") ?? "");
  if (parts === null) return "AccessDenied";
  const [, keyId, day, region, signedList, signature] = parts as unknown as string[];
  if (!sameText(keyId ?? "", config.accessKeyId)) return "InvalidAccessKeyId";
  const amzDate = one(req, "x-amz-date") ?? "";
  const date = AMZ_DATE.exec(amzDate);
  if (date === null || region !== config.region || amzDate.slice(0, 8) !== day) {
    return "SignatureDoesNotMatch";
  }
  const [, y, mo, d, h, mi, s] = date as unknown as string[];
  const at = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  const now = (config.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) return "RequestTimeTooSkewed";
  const names = (signedList ?? "").split(";");
  const sorted = [...names].sort();
  const required = req.method === "PUT" ? [...ALWAYS_SIGNED, ...PUT_SIGNED] : ALWAYS_SIGNED;
  if (
    names.join(";") !== sorted.join(";") ||
    new Set(names).size !== names.length ||
    !required.every((name) => names.includes(name))
  ) {
    return "SignatureDoesNotMatch";
  }
  const lines: string[] = [];
  for (const name of names) {
    const value = one(req, name);
    if (value === null) return "SignatureDoesNotMatch";
    lines.push(`${name}:${value.trim().replace(/ +/gu, " ")}\n`);
  }
  const payload = one(req, "x-amz-content-sha256") ?? "";
  if (!HEX64.test(payload)) return "SignatureDoesNotMatch";
  const canonical = [req.method, path, "", lines.join(""), names.join(";"), payload].join("\n");
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonical, "utf8").digest("hex"),
  ].join("\n");
  let key = hmac(`AWS4${config.secretAccessKey}`, day ?? "");
  for (const part of [config.region, "s3", "aws4_request"]) key = hmac(key, part);
  const expected = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return sameText(expected, signature ?? "") ? null : "SignatureDoesNotMatch";
}

/** The body, or null once it grows past the limit (the rest is not kept). */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_OBJECT_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

/** Every directory from the root down must be a real directory, never a link. */
async function realDirectories(root: string, parts: readonly string[], make: boolean) {
  let at = root;
  for (const part of ["", ...parts]) {
    at = part === "" ? at : join(at, part);
    let stat = await lstat(at).catch(() => null);
    if (stat === null && make) {
      // Another write may make the same directory at once; it is then judged below.
      await mkdir(at, { mode: 0o700 }).catch((error: unknown) => {
        if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
      });
      stat = await lstat(at);
    }
    if (stat === null) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("not a directory");
  }
  return true;
}

/** The bytes of a regular file, never through a link; null when it does not exist. */
async function readObject(file: string): Promise<Buffer | null> {
  const stat = await lstat(file).catch(() => null);
  if (stat === null) return null;
  if (!stat.isFile()) throw new Error("not a file");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Writes once: a private temporary file, then a hard link that fails if the key exists. */
async function writeOnce(dir: string, file: string, bytes: Buffer): Promise<boolean> {
  const temp = join(dir, `.tmp-${randomBytes(12).toString("hex")}`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temp, file);
    return true;
  } catch (error) {
    if (Reflect.get(error as object, "code") !== "EEXIST") throw error;
    // Only an object already under the key is "exists"; a directory there is not one.
    const held = await lstat(file);
    if (!held.isFile()) throw new Error("not a file");
    return false;
  } finally {
    // Removed on every path, a failed write included.
    await unlink(temp).catch(() => undefined);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, config: LocalS3Config) {
  const method = req.method ?? "";
  if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
    return answer(res, 405, "MethodNotAllowed");
  }
  const path = req.url ?? "";
  if (!PATH.test(path)) return answer(res, 400, "InvalidURI");
  const parts = path.slice(1).split("/");
  if (!parts.every((part) => SEGMENT.test(part) && part !== "." && part !== "..")) {
    return answer(res, 400, "InvalidURI");
  }
  const fault = signatureFault(req, path, config);
  if (fault !== null) return answer(res, 403, fault);
  const [bucket, ...key] = parts;
  if (bucket !== config.bucket) return answer(res, 404, "NoSuchBucket");
  if (key.length === 0 || key.some((part) => part.startsWith(".tmp-"))) {
    return answer(res, 400, "InvalidURI");
  }
  const dirs = [bucket, ...key.slice(0, -1)];
  const dir = join(config.root, ...dirs);
  const file = join(dir, key[key.length - 1] ?? "");
  const payloadHash = one(req, "x-amz-content-sha256") ?? "";

  if (method === "PUT") {
    if (one(req, "if-none-match") !== "*") return answer(res, 501, "NotImplemented");
    const declared = Number(one(req, "content-length") ?? "NaN");
    if (!Number.isSafeInteger(declared) || declared < 0)
      return answer(res, 411, "MissingContentLength");
    if (declared > MAX_OBJECT_BYTES) return answer(res, 400, "EntityTooLarge");
    const body = await readBody(req);
    if (body === null) return answer(res, 400, "EntityTooLarge");
    const digest = createHash("sha256").update(body).digest();
    if (!sameText(digest.toString("hex"), payloadHash)) {
      return answer(res, 400, "XAmzContentSHA256Mismatch");
    }
    const checksum = digest.toString("base64");
    if (!sameText(checksum, one(req, "x-amz-checksum-sha256") ?? "")) {
      return answer(res, 400, "BadDigest");
    }
    await realDirectories(config.root, dirs, true);
    if (!(await writeOnce(dir, file, body))) return answer(res, 412, "PreconditionFailed");
    return answer(res, 200, null, { "x-amz-checksum-sha256": checksum });
  }

  // GET and HEAD sign the hash of an empty body.
  if (payloadHash !== createHash("sha256").digest("hex")) {
    return answer(res, 400, "XAmzContentSHA256Mismatch");
  }
  const bytes = (await realDirectories(config.root, dirs, false)) ? await readObject(file) : null;
  if (bytes === null) return answer(res, 404, method === "GET" ? "NoSuchKey" : null);
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64"),
  };
  res.writeHead(200, headers);
  res.end(method === "GET" ? bytes : undefined);
}

/** The request handler over `config.root`; faults of the disk answer 500, never details. */
export function localS3Server(config: LocalS3Config): Server {
  return createServer((req, res) => {
    handle(req, res, config).catch(() => {
      if (!res.headersSent) answer(res, 500, "InternalError");
      else res.destroy();
    });
  });
}

/** The configuration from the environment the stack gives this process alone. */
export function localS3Config(env: Env): LocalS3Config & { port: number } {
  // An allowlist, as for the fake OIDC provider and the development signer:
  // unset, empty or misspelt counts as production (F-020).
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new Error("the local S3 runs only with NODE_ENV development or test");
  }
  const port = Number(env.PORT);
  if (!/^\d{4,5}$/u.test(env.PORT ?? "") || port < 1024 || port > 65_535) {
    throw new Error("PORT is not a port 1024-65535");
  }
  const named = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new Error(`${name} is not set`);
    return value;
  };
  const root = named("VS1_S3_ROOT");
  if (!root.startsWith("/")) throw new Error("VS1_S3_ROOT must be absolute");
  const bucket = named("VS1_S3_BUCKET");
  if (!SEGMENT.test(bucket)) throw new Error("VS1_S3_BUCKET is not valid");
  return {
    port,
    root,
    bucket,
    region: named("VS1_S3_REGION"),
    accessKeyId: named("EVIDENCE_S3_VS1_KEY_ID"),
    secretAccessKey: named("EVIDENCE_S3_VS1_SECRET"),
  };
}

/** The only address the local S3 listens on (loopback; never 0.0.0.0 or another interface). */
export const LOCAL_S3_HOST = "127.0.0.1";

/** Starts the local S3 on loopback; resolves once it listens. */
export function startLocalS3(config: LocalS3Config & { port: number }): Promise<Server> {
  const server = localS3Server(config);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, LOCAL_S3_HOST, () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let config: ReturnType<typeof localS3Config>;
  try {
    config = localS3Config(process.env);
  } catch (error) {
    // Closed messages: they name variables, never a value.
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  }
  const server = await startLocalS3(config);
  console.log(`local S3 on ${LOCAL_S3_HOST}:${config.port}`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
