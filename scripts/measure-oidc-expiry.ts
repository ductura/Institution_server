import { startVitest, type Reporter, type TestCase } from "vitest/node";

// Use the same two cases on both the original and patched checkout.
const TEST_FILE = "server/http/auth.integration.test.ts";
const CASE_NAMES = /(?:^| )expired(?:: tokens past their lifetime when used|, used at once:)/u;
const DEFAULT_RUNS = 200;

async function main(): Promise<number> {
  const [count = String(DEFAULT_RUNS), ...extra] = process.argv.slice(2);
  const runs = Number(count);
  if (extra.length > 0 || !/^\d+$/u.test(count) || !Number.isSafeInteger(runs) || runs < 1) {
    console.error("Usage: node scripts/measure-oidc-expiry.ts [runs per case, default: 200]");
    return 2;
  }

  const cases: TestCase[] = [];
  let completed = false;
  const reporter: Reporter = {
    onTestCaseResult(test) {
      if (CASE_NAMES.test(test.name)) cases.push(test);
    },
    onTestRunEnd(modules, errors, reason) {
      for (const error of errors) console.error(error.message);
      for (const module of modules) {
        for (const error of module.errors()) console.error(error.message);
      }
      completed =
        reason !== "interrupted" &&
        modules.length === 1 &&
        modules.every((module) => module.errors().length === 0) &&
        errors.length === 0;
    },
  };

  console.log(`OIDC expiry: ${runs} runs per case, one worker, no retries (${process.version})`);
  const start = performance.now();
  await startVitest([TEST_FILE], {
    run: true,
    project: ["integration"],
    testNamePattern: CASE_NAMES,
    maxWorkers: 1,
    fileParallelism: false,
    maxConcurrency: 1,
    repeats: runs - 1,
    retry: 0,
    bail: 0,
    silent: true,
    reporters: [reporter],
  });

  let complete = completed && cases.length === 2;
  let failed = false;
  for (const test of cases) {
    const attempts = test.attempts();
    const executed = attempts.filter((attempt) => attempt.state !== "skipped");
    const failures = executed.filter((attempt) => attempt.state === "failed");
    const rate = executed.length
      ? `${((100 * failures.length) / executed.length).toFixed(2)}%`
      : "n/a";
    console.log(`${test.name}: ${failures.length}/${executed.length} failed (${rate})`);
    const firstError = failures[0]?.errors?.[0]?.message;
    if (firstError) console.log(`  First failure: ${firstError}`);
    complete &&=
      executed.length === runs &&
      executed.every((attempt, index) => attempt.retryIndex === 0 && attempt.repeatIndex === index);
    failed ||= failures.length > 0;
  }

  console.log(`Elapsed: ${((performance.now() - start) / 1_000).toFixed(1)} s`);
  if (!complete) {
    console.error("Incomplete measurement: expected both cases to finish every run.");
    return 2;
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
