import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

// DAN-953: the PGDG install step gets one retry, that step only. The real
// step from ci.yml runs as GitHub runs it (bash --noprofile --norc -eo
// pipefail), with stub curl, gpg, sudo and sleep first on PATH. Stub sudo runs
// nothing; stub sleep only logs, so no real time passes.
const ROOT = resolve(import.meta.dirname, "../..");
const CI = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
const NAME = "Instalacija PostgreSQL-a (PGDG)";
type Step = { name?: string; run?: string; env?: Record<string, string> };
const steps = (parse(CI) as { jobs: Record<string, { steps: Step[] }> }).jobs;
const step = steps.database!.steps.find((each) => each.name === NAME)!;
const FINGERPRINT = step.env!.PGDG_KEY_FINGERPRINT!;

const dir = mkdtempSync(join(tmpdir(), "dan-953-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const osRelease = join(dir, "os-release");
writeFileSync(osRelease, "VERSION_CODENAME=noble\n");
const script = join(dir, "step.sh");
writeFileSync(script, step.run!.replace("/etc/os-release", osRelease));
// A call is named curl, gpg, sleep, sudo-install, sudo-tee, apt-get-update or
// apt-get-install; FAIL_<name> sets how many of its first calls fail.
const STUB = [
  "#!/bin/sh",
  'n="$(basename "$0")"',
  'if [ "$n" = sudo ]; then n="sudo-$1"; [ "$1" = apt-get ] && n="apt-get-$2"; fi',
  'if [ "$n" = sudo-tee ]; then in="$(cat)"; echo "$n $* <$in>" >> "$LOG"; else echo "$n $*" >> "$LOG"; fi',
  'eval "fail=\\${FAIL_$(echo "$n" | tr - _):-0}"',
  '[ "$(grep -c "^$n " "$LOG")" -gt "$fail" ] || exit 1',
  '[ "$n" = gpg ] && echo "fpr:::::::::$FPR:"',
  "exit 0",
  "",
].join("\n");
for (const name of ["curl", "gpg", "sudo", "sleep"]) {
  writeFileSync(join(dir, name), STUB);
  chmodSync(join(dir, name), 0o755);
}

const run = (fail: Record<string, number> = {}, fpr = FINGERPRINT) => {
  const log = join(dir, `log-${Math.random()}`);
  writeFileSync(log, "");
  const env = Object.fromEntries([
    ["PATH", `${dir}:${process.env.PATH ?? ""}`],
    ["RUNNER_TEMP", dir],
    ["PGDG_KEY_FINGERPRINT", FINGERPRINT],
    ["FPR", fpr],
    ["LOG", log],
    ...Object.entries(fail).map(([n, k]) => [`FAIL_${n.replaceAll("-", "_")}`, `${k}`]),
  ]);
  const { status } = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    env,
  });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  const named = (name: string) => calls.filter((call) => call.startsWith(`${name} `));
  return { status, calls, named };
};

const COMMANDS = ["curl", "gpg", "sudo-install", "sudo-tee", "apt-get-update", "apt-get-install"];

describe("PGDG install step", () => {
  it.each(COMMANDS)("fails when %s fails in both attempts", (name) => {
    const { status, named } = run({ [name]: 2 });
    expect(status).not.toBe(0);
    expect(named(name)).toHaveLength(2);
    expect(named("sleep")).toEqual(["sleep 30"]);
  });

  it("stops an attempt at the first failure: a wrong key fingerprint never reaches apt-get", () => {
    const { status, named } = run({}, "0".repeat(40));
    expect(status).not.toBe(0);
    expect(named("gpg")).toHaveLength(2);
    expect([...named("sudo-install"), ...named("apt-get-update")]).toEqual([]);
  });

  it.each(COMMANDS)("passes when %s fails only in the first attempt", (name) => {
    const { status, named } = run({ [name]: 1 });
    expect(status).toBe(0);
    expect(named(name)).toHaveLength(2);
    expect(named("sleep")).toEqual(["sleep 30"]);
    expect(named("apt-get-install")).toHaveLength(name === "apt-get-install" ? 2 : 1);
  });

  it("the retry repeats the same install and the same source list", () => {
    const { named } = run({ "apt-get-install": 1 });
    const [first, second] = [named("sudo-install"), named("sudo-tee")];
    expect(first[0]).toBe(first[1]);
    expect(second[0]).toBe(second[1]);
    expect(second[0]).toContain("noble-pgdg main");
  });

  it("runs once and does not wait when nothing fails", () => {
    const { status, calls, named } = run();
    expect(status).toBe(0);
    expect(named("sleep")).toEqual([]);
    expect(calls.map((call) => call.split(" ")[0])).toEqual(COMMANDS);
  });

  it("retries no other step", () => {
    expect(step.run!.split("/etc/os-release")).toHaveLength(2);
    expect(CI.split("pgdg_install ||")).toHaveLength(2);
    expect(CI.split("sleep 30")).toHaveLength(2);
    expect(step.run).toContain("pgdg_install ||");
    expect(step.run).toContain("sleep 30");
    expect(CI).not.toMatch(/continue-on-error/);
  });
});
