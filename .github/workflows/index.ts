// SRV-CI-SHARD-PO-VREMENU: split the vitest files of one project across the
// legs of the checks job by measured time instead of by file count.
//
// Plan: every file costs its measured time (shard-timings.json, ms of the
// last measured run) plus a fixed import overhead; files go, slowest first,
// to the leg with the least load (greedy, deterministic: ties by name and
// leg). A leg that also runs the property tests starts with that load. A
// file the table does not know costs the median, so a new test still runs
// on exactly one leg. Every file is on exactly one leg by construction, and
// the plan checks it before it prints anything.
//
// This file, shard-plan.ts (the command) and shard-timings.json sit in .github/workflows/ (GitHub reads
// only *.yml and *.yaml there). Not built.
//
// Usage (shard-plan.ts): node shard-plan.ts <unit|integration> <leg i/n> [--reserve 3,4]
//   prints the files of that project on the leg, one per line, relative to the repo root.
// Import and startup cost per file that the test time does not show.
export const FILE_OVERHEAD_MS = 150;
// The property tests (68 files, about 73 s of test time, run in parallel with
// less gain than the others) weigh like this on the legs that run them.
export const RESERVED_LOAD_MS = 100_000;
// A file this slow keeps a leg's CPU busy for a long time; tests that run beside
// it get slow too and can pass their testTimeout (CI run 45938010744, dynamic-load
// beside check-breaking). Such files go on different legs while there are legs
// without one.
export const HEAVY_FILE_MS = 20_000;

export function plan(
  files: readonly string[],
  timings: Readonly<Record<string, number>>,
  legCount: number,
  reserved: readonly number[] = [],
): string[][] {
  if (!Number.isInteger(legCount) || legCount < 1) throw new Error("legCount");
  const unique = [...new Set(files)].sort();
  const valid = (ms: number | undefined): ms is number =>
    ms !== undefined && Number.isFinite(ms) && ms >= 0;
  const known = unique
    .map((file) => timings[file])
    .filter(valid)
    .sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 0;
  const cost = (file: string): number => {
    const ms = timings[file];
    return (valid(ms) ? ms : median) + FILE_OVERHEAD_MS;
  };
  const load: number[] = Array.from({ length: legCount }, (_, i) =>
    reserved.includes(i + 1) ? RESERVED_LOAD_MS : 0,
  );
  const heavy: number[] = Array.from({ length: legCount }, () => 0);
  const legs: string[][] = Array.from({ length: legCount }, () => []);
  const order = [...unique].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : 1));
  for (const file of order) {
    const isHeavy = cost(file) >= HEAVY_FILE_MS;
    // A heavy file first compares the number of heavy files on a leg, then load.
    const rank = (i: number): [number, number] => [isHeavy ? (heavy[i] ?? 0) : 0, load[i] ?? 0];
    let best = 0;
    for (let i = 1; i < legCount; i++) {
      const [ha, la] = rank(i);
      const [hb, lb] = rank(best);
      if (ha < hb || (ha === hb && la < lb)) best = i;
    }
    legs[best]?.push(file);
    load[best] = (load[best] ?? 0) + cost(file);
    if (isHeavy) heavy[best] = (heavy[best] ?? 0) + 1;
  }
  const all = legs.flat().sort();
  if (all.length !== unique.length || all.some((file, i) => file !== unique[i])) {
    throw new Error("shard plan does not cover every file exactly once");
  }
  return legs.map((leg) => leg.sort());
}
