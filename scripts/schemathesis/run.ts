// ISTR-7: the Schemathesis probe of openapi/v1.json (scripts/schemathesis/README.md).
//
//   node scripts/schemathesis/run.ts --samotest      fake server, no stack
//   node scripts/schemathesis/run.ts [--spec FILE]   local stack, demo student
//
// Schemathesis runs as a child process with an argument list (no shell, so no
// path rewriting), its reports go to .local/schemathesis/, and the session
// cookie reaches it only through the environment of that process.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertLocal, EDGE_ORIGIN, ISSUER, LOCAL_DIR, signInSession } from "../lokalno/index.ts";

import { allowlistProblems, SCHEMATHESIS_VERSION, STUDENT_READS } from "./allowlist.ts";
import { formatSummary, type Har, type RunReport, type RunSummary, summarize } from "./summary.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const STUDENT = "sim:student:demo-student-3@demo.ductus.test";
/** The checks that only read a response; unsupported_method (TRACE) and the stateful ones stay off. */
const CHECKS = [
  "not_a_server_error",
  "status_code_conformance",
  "content_type_conformance",
  "response_headers_conformance",
  "response_schema_conformance",
];
const COOKIE_ENV = "DUCTUS_ST_SESSION";

export type ProbeOptions = {
  readonly bin: string;
  readonly specFile: string;
  readonly origin: string;
  readonly paths: readonly string[];
  readonly reportDir: string;
  /** name=value of the session cookie; never printed. */
  readonly cookie: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxExamples: number;
  readonly maxSeconds: number;
};

export type ProbeResult = {
  readonly exitCode: number;
  readonly summary: RunSummary;
  /** Report files (or "izlaz") that hold the cookie value or an unfiltered cookie. */
  readonly leaks: readonly string[];
};

/** schemathesis.toml: the cookie is read from the environment, so the file holds no secret. */
export function configToml(cookieName: string, headers: Readonly<Record<string, string>>): string {
  const lines = ["[headers]", `Cookie = "${cookieName}=\${${COOKIE_ENV}}"`];
  for (const [name, value] of Object.entries(headers))
    lines.push(`${JSON.stringify(name)} = ${JSON.stringify(value)}`);
  // No crash cache in the checkout (it would keep requests with the cookie); the coverage phase otherwise sends every undeclared method (TRACE, PUT, POST ...) to each path.
  lines.push("", "[cache]", "enabled = false", "", "[phases.coverage]", "unexpected-methods = []");
  return `${lines.join("\n")}\n`;
}

/**
 * The spec cut down to the GET operations of `paths`. Schemathesis combines
 * separate --include-* options with OR, so filters alone let other operations
 * through; a run can only reach what this spec still has.
 */
export function restrictSpec<
  T extends { readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>> },
>(spec: T, paths: readonly string[]): T {
  const kept: Record<string, Record<string, unknown>> = {};
  for (const path of paths) {
    const item = spec.paths?.[path];
    if (item?.["get"] === undefined) continue;
    // Path-level parameters stay; every other method goes.
    kept[path] =
      item["parameters"] === undefined
        ? { get: item["get"] }
        : { get: item["get"], parameters: item["parameters"] };
  }
  return { ...spec, paths: kept };
}

export function schemathesisArgs(
  options: ProbeOptions,
  configFile: string,
  specFile: string,
): string[] {
  return [
    "--config-file",
    configFile,
    "--no-color",
    "run",
    specFile,
    "--url",
    options.origin,
    "--phases",
    "examples,coverage,fuzzing",
    "--checks",
    CHECKS.join(","),
    "--max-examples",
    String(options.maxExamples),
    "--max-time",
    String(options.maxSeconds),
    "--workers",
    "1",
    "--rate-limit",
    "20/s",
    "--generation-database",
    "none",
    "--output-sanitize",
    "true",
    "--report",
    "json,har",
    "--report-dir",
    options.reportDir,
    "--report-json-path",
    join(options.reportDir, "report.json"),
    "--report-har-path",
    join(options.reportDir, "requests.har.json"),
  ];
}

/** Where the secret shows: in a file or the captured output, by value or as an unfiltered cookie. */
export function leaksIn(texts: ReadonlyMap<string, string>, cookie: string): string[] {
  const [name = "", value = ""] = cookie.split(/=(.*)/su);
  const unfiltered = new RegExp(`${name}=(?!\\[Filtered\\]|\\$\\{)`, "u");
  return [...texts]
    .filter(([, text]) => (value !== "" && text.includes(value)) || unfiltered.test(text))
    .map(([where]) => where);
}

function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

export async function assertVersion(bin: string): Promise<void> {
  const { output } = await run(bin, ["--version"], process.env);
  if (!output.includes(SCHEMATHESIS_VERSION))
    throw new Error(`Schemathesis ${SCHEMATHESIS_VERSION} nije pronađen (${bin}).`);
}

export async function probe(options: ProbeOptions): Promise<ProbeResult> {
  const spec = JSON.parse(readFileSync(options.specFile, "utf8")) as Parameters<
    typeof allowlistProblems
  >[0];
  const problems = allowlistProblems(spec, options.paths);
  if (problems.length > 0)
    throw new Error(`Popis ruta ne odgovara specifikaciji:\n${problems.join("\n")}`);
  mkdirSync(options.reportDir, { recursive: true });
  const configFile = join(options.reportDir, "schemathesis.toml");
  writeFileSync(configFile, configToml(options.cookie.split("=", 1)[0] ?? "", options.headers));
  const env = {
    ...process.env,
    [COOKIE_ENV]: options.cookie.slice(options.cookie.indexOf("=") + 1),
  };
  const restricted = join(options.reportDir, "spec-restricted.json");
  writeFileSync(restricted, JSON.stringify(restrictSpec(spec, options.paths)));
  const { code, output } = await run(
    options.bin,
    schemathesisArgs(options, configFile, restricted),
    env,
  );

  const texts = new Map([["izlaz", output]]);
  for (const file of readdirSync(options.reportDir).filter((name) => !name.startsWith("spec")))
    texts.set(file, readFileSync(join(options.reportDir, file), "utf8"));
  const leaks = leaksIn(texts, options.cookie);
  writeFileSync(
    join(options.reportDir, "output.txt"),
    leaks.length > 0 ? "(izostavljeno: sadržavalo je kolačić)\n" : output,
  );

  const report = JSON.parse(texts.get("report.json") ?? "{}") as RunReport;
  const har = JSON.parse(texts.get("requests.har.json") ?? '{"log":{"entries":[]}}') as Har;
  return { exitCode: code, summary: summarize(report, har, options.paths, options.origin), leaks };
}

// --- samotest: a fake server with one route that keeps to its schema and one that does not

const SELF_COOKIE = "__Host-ductus_session";
const SELF_VALUE = "samotest-0123456789abcdef";
const closedBody = {
  type: "object",
  required: ["state"],
  properties: { state: { type: "string", enum: ["ok"] } },
  additionalProperties: false,
};
const operation = {
  responses: {
    "200": { description: "ok", content: { "application/json": { schema: closedBody } } },
    "401": { description: "no session" },
  },
};
export const SELF_SPEC = {
  openapi: "3.0.3",
  info: { title: "samotest", version: "1" },
  paths: {
    "/api/v1/good": { get: operation, post: operation },
    "/api/v1/broken": { get: operation },
    "/api/v1/outside": { get: operation },
  },
};
export const SELF_PATHS = ["/api/v1/good", "/api/v1/broken"];
/** Schemathesis' own capability probes: two GETs outside the API, before the run. */
const PROBE_REQUESTS = /^GET (?:\/|\/schemathesis-probe\S*)$/u;

function fakeServer(seen: string[]) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    seen.push(`${request.method} ${path}`);
    if (request.headers.cookie !== `${SELF_COOKIE}=${SELF_VALUE}`) {
      response.writeHead(401).end();
      return;
    }
    // The broken route answers a field its closed schema does not have.
    const body = path === "/api/v1/broken" ? { state: "ok", extra: true } : { state: "ok" };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
}

/** Problems with a self-test run; empty when the probe told the broken route from the good one and stayed in scope. */
export function selfTestProblems(result: ProbeResult, seen: readonly string[]): string[] {
  const problems: string[] = [];
  const blamed = result.summary.disagreements.flatMap((item) => item.operations);
  if (result.exitCode === 0)
    problems.push("Schemathesis je završio s 0 iako ruta odstupa od sheme");
  if (!blamed.includes("GET /api/v1/broken"))
    problems.push("neslaganje na /api/v1/broken nije prijavljeno");
  if (blamed.some((operation) => operation !== "GET /api/v1/broken"))
    problems.push(`prijavljeno i drugo: ${blamed.join(", ")}`);
  if (result.summary.unchecked.length > 0)
    problems.push(`bez 2xx: ${result.summary.unchecked.join(", ")}`);
  problems.push(...result.summary.scope);
  const outside = seen.filter(
    (request) =>
      !SELF_PATHS.some((path) => request === `GET ${path}`) && !PROBE_REQUESTS.test(request),
  );
  if (outside.length > 0)
    problems.push(`poslužitelj je primio i: ${[...new Set(outside)].join(", ")}`);
  if (result.leaks.length > 0) problems.push(`kolačić u: ${result.leaks.join(", ")}`);
  return problems;
}

async function selfTest(bin: string, reportDir: string): Promise<number> {
  const seen: string[] = [];
  const server = fakeServer(seen);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mkdirSync(reportDir, { recursive: true });
  const specFile = join(reportDir, "samotest-spec.json");
  writeFileSync(specFile, JSON.stringify(SELF_SPEC));
  try {
    const result = await probe({
      bin,
      specFile,
      origin,
      paths: SELF_PATHS,
      reportDir,
      cookie: `${SELF_COOKIE}=${SELF_VALUE}`,
      headers: {},
      maxExamples: 5,
      maxSeconds: 60,
    });
    console.log(formatSummary(result.summary));
    const problems = selfTestProblems(result, seen);
    console.log(
      problems.length === 0
        ? "SAMOTEST: PROLAZ"
        : `SAMOTEST: PAD\n${problems.map((p) => `- ${p}`).join("\n")}`,
    );
    return problems.length === 0 ? 0 : 1;
  } finally {
    server.close();
  }
}

async function stackRun(bin: string, reportDir: string, specFile: string): Promise<number> {
  assertLocal(process.env);
  // The stack sends the sign-in callback to the edge, so the probe uses the browser's origin too.
  const origin = EDGE_ORIGIN;
  const student = await signInSession(origin, ISSUER, STUDENT);
  const startedAt = new Date().toISOString();
  try {
    const result = await probe({
      bin,
      specFile,
      origin,
      paths: STUDENT_READS,
      reportDir,
      cookie: student.session,
      headers: { origin, "sec-fetch-site": "same-origin", "ductus-protocol": "1" },
      maxExamples: 20,
      maxSeconds: 180,
    });
    const text = `Pokret ${startedAt} – ${new Date().toISOString()}, ${origin}, Schemathesis ${SCHEMATHESIS_VERSION}\n${formatSummary(result.summary)}`;
    writeFileSync(join(reportDir, "sazetak.txt"), `${text}\n`);
    console.log(text);
    if (result.leaks.length > 0) {
      console.log(`KOLAČIĆ u izvještaju (${result.leaks.join(", ")}): izvještaj ne dijeli.`);
      return 2;
    }
    return result.summary.scope.length > 0 ? 2 : 0;
  } finally {
    const logout = await student.api("auth/logout", {});
    await logout.body?.cancel();
  }
}

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

async function main(argv: readonly string[]): Promise<number> {
  const bin = process.env["SCHEMATHESIS_BIN"] ?? "schemathesis";
  await assertVersion(bin);
  const stamp = new Date().toISOString().replaceAll(":", "").replace(/\..*/u, "Z");
  const reportDir = join(LOCAL_DIR, "schemathesis", stamp);
  if (argv.includes("--samotest")) return selfTest(bin, reportDir);
  return stackRun(bin, reportDir, option(argv, "--spec") ?? join(ROOT, "openapi", "v1.json"));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      console.error(
        `schemathesis: ${error instanceof Error ? error.message : "nepoznata pogreška"}`,
      );
      process.exitCode = 1;
    },
  );
}
