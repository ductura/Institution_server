import { spawn } from "node:child_process";

export type DockerResult = { code: number; stdout: Buffer; stderr: string; wallMs: number };

/** Runs `docker <args>`, writes `input` to its stdin and collects the output. */
export function runDocker(args: readonly string[], input?: Buffer): Promise<DockerResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
        wallMs: performance.now() - started,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
