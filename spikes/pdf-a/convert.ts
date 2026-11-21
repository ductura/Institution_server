// DOCX → PDF/A-2b with LibreOffice in a throwaway container that has no
// network, no host mount, a read-only root, no capabilities and fixed limits.
// The DOCX goes in on stdin and the PDF comes out on stdout.
import { runDocker } from "./docker.ts";
import { LIBREOFFICE_IMAGE } from "./images.ts";

/** LibreOffice knows PDF/A-1b, 2b and 3b; 2 selects PDF/A-2b. */
const PDF_A_2B_FILTER = 'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"2"}}';
const PLAIN_PDF_FILTER = "pdf:writer_pdf_Export";

export type Limits = { cpus: number; memoryMiB: number };
export const DEFAULT_LIMITS: Limits = { cpus: 1, memoryMiB: 1024 };

const METRICS_PREFIX = "SPIKE_METRICS ";

// Reads its own cgroup after the conversion: v2 (memory.peak, cpu.stat) or v1
// (memory.max_usage_in_bytes, cpuacct.usage). The peak includes tmpfs pages,
// which is what the memory limit counts.
const CONVERT_SCRIPT = `set -eu
mkdir -p /tmp/w
cat > /tmp/w/rad.docx
start=$(date +%s%N)
soffice --headless --norestore --nolockcheck --nodefault --nofirststartwizard \\
  "-env:UserInstallation=file:///tmp/lo" --convert-to "$FILTER" --outdir /tmp/w /tmp/w/rad.docx >&2
end=$(date +%s%N)
test -s /tmp/w/rad.pdf
if [ -r /sys/fs/cgroup/memory.peak ]; then
  mem=$(cat /sys/fs/cgroup/memory.peak)
  cpu=$(awk '/^usage_usec/ { printf "%d", $2 * 1000 }' /sys/fs/cgroup/cpu.stat)
else
  mem=$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes)
  cpu=$(cat /sys/fs/cgroup/cpuacct/cpuacct.usage)
fi
echo "${METRICS_PREFIX}{\\"convertNs\\":$((end - start)),\\"cpuNs\\":$cpu,\\"memPeakBytes\\":$mem}" >&2
cat /tmp/w/rad.pdf`;

/**
 * Arguments of `docker run` for one isolated LibreOffice process. `script`
 * runs under /bin/sh in the image; the conversion and the network test share
 * these arguments, so the test checks the container the conversion uses.
 */
export function isolatedRunArgs(
  script: string,
  limits: Limits = DEFAULT_LIMITS,
  env: readonly `${string}=${string}`[] = [],
): string[] {
  return [
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1001:1001",
    `--cpus=${limits.cpus}`,
    `--memory=${limits.memoryMiB}m`,
    `--memory-swap=${limits.memoryMiB}m`,
    "--pids-limit=256",
    "--env=HOME=/tmp",
    ...env.map((entry) => `--env=${entry}`),
    "--entrypoint=/bin/sh",
    LIBREOFFICE_IMAGE,
    "-c",
    script,
  ];
}

export type ConversionMetrics = {
  /** docker run from start to exit, container start included. */
  wallMs: number;
  /** soffice alone, measured inside the container. */
  convertMs: number;
  /** CPU time of the whole container (all processes). */
  cpuMs: number;
  /** Peak memory of the container cgroup. */
  memPeakMiB: number;
};

export type Conversion = { pdf: Buffer; metrics: ConversionMetrics };

export function parseMetrics(stderr: string, wallMs: number): ConversionMetrics {
  const line = stderr.split("\n").find((entry) => entry.startsWith(METRICS_PREFIX));
  if (line === undefined) throw new Error("conversion printed no metrics");
  const raw: unknown = JSON.parse(line.slice(METRICS_PREFIX.length));
  if (typeof raw !== "object" || raw === null) throw new Error("metrics are not an object");
  const value = (key: string): number => {
    const entry: unknown = Reflect.get(raw, key);
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw new Error(`metric ${key} is not a non-negative number`);
    }
    return entry;
  };
  return {
    wallMs,
    convertMs: value("convertNs") / 1e6,
    cpuMs: value("cpuNs") / 1e6,
    memPeakMiB: value("memPeakBytes") / 1024 / 1024,
  };
}

export type PdfKind = "pdf-a-2b" | "plain";

export async function convertDocx(
  docx: Buffer,
  kind: PdfKind = "pdf-a-2b",
  limits: Limits = DEFAULT_LIMITS,
): Promise<Conversion> {
  const filter = kind === "pdf-a-2b" ? PDF_A_2B_FILTER : PLAIN_PDF_FILTER;
  const result = await runDocker(
    isolatedRunArgs(CONVERT_SCRIPT, limits, [`FILTER=${filter}`]),
    docx,
  );
  if (result.code !== 0) {
    throw new Error(
      `LibreOffice container exited with ${result.code}: ${result.stderr.slice(-2000)}`,
    );
  }
  if (!result.stdout.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("LibreOffice container returned no PDF");
  }
  return { pdf: result.stdout, metrics: parseMetrics(result.stderr, result.wallMs) };
}
