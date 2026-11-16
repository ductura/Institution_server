// DAN-867: GitHub runs a `run:` step with `shell: bash` as
// `bash --noprofile --norc -eo pipefail {0}`; without `shell:` it is
// `bash -e {0}` (`sh -e` in a container without bash), so a failed command
// inside a pipe passes green. Only the exact string `bash` keeps pipefail.

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `defaults.run.shell` of a workflow or job, `inherited` when it sets none. */
function defaultShell(owner: Node, inherited: unknown): unknown {
  const run = isNode(owner["defaults"]) ? owner["defaults"]["run"] : undefined;
  return isNode(run) && Object.hasOwn(run, "shell") ? run["shell"] : inherited;
}

function stepViolations(steps: unknown, shell: unknown, at: string): string[] {
  if (!Array.isArray(steps)) return [`${at}.steps: shell unknown, not a list`];
  return steps.flatMap((step: unknown, i) => {
    if (!isNode(step)) return [`${at}.steps[${i}]: shell unknown, not a mapping`];
    if (!Object.hasOwn(step, "run")) return [];
    const own = Object.hasOwn(step, "shell") ? step["shell"] : shell;
    return own === "bash" ? [] : [`${at}.steps[${i}]: shell ${JSON.stringify(own) ?? "unset"}`];
  });
}

/** Paths of `<<` merge keys, which GitHub does not apply. */
function mergeKeys(value: unknown, at: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => mergeKeys(item, `${at}[${i}]`));
  if (!isNode(value)) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === "<<" ? [`${at}.<<: shell unknown, merge key`] : mergeKeys(child, `${at}.${key}`),
  );
}

/**
 * Every `run:` step of a parsed workflow, or of a composite action (`runs`),
 * whose shell is not exactly `bash`. Step `shell:` wins over the job's
 * `defaults.run.shell`, which wins over the workflow's; a composite step has
 * no default. Anything that is not the expected shape is a violation too.
 */
export function shellViolations(doc: unknown): string[] {
  if (!isNode(doc)) return ["document: shell unknown, not a mapping"];
  const violations = mergeKeys(doc, "document");
  if (isNode(doc["runs"]) && Object.hasOwn(doc["runs"], "steps"))
    violations.push(...stepViolations(doc["runs"]["steps"], undefined, "runs"));
  if (!Object.hasOwn(doc, "jobs")) return violations;
  if (!isNode(doc["jobs"])) return [...violations, "jobs: shell unknown, not a mapping"];
  const shell = defaultShell(doc, undefined);
  for (const [name, job] of Object.entries(doc["jobs"])) {
    if (!isNode(job)) violations.push(`jobs.${name}: shell unknown, not a mapping`);
    else if (Object.hasOwn(job, "steps"))
      violations.push(...stepViolations(job["steps"], defaultShell(job, shell), `jobs.${name}`));
  }
  return violations;
}
