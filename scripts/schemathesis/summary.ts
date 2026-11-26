// ISTR-7: reads one Schemathesis run (its JSON report and HAR file) and says
// what it checked, what disagreed with the spec and whether the run stayed in
// scope. Only counts and route names leave this module, never a payload.

/** The part of Schemathesis' JSON report (--report json) this reads. */
export type RunReport = {
  readonly operations?: { readonly selected?: number; readonly tested?: number };
  readonly failures?: readonly {
    readonly code?: string;
    readonly title?: string;
    readonly count?: number;
    readonly operations?: readonly string[];
  }[];
  readonly errors?: readonly unknown[];
  readonly warnings?: Readonly<Record<string, readonly string[] | undefined>>;
};

/** The part of a HAR 1.2 file (--report har) this reads. */
export type Har = {
  readonly log: {
    readonly entries: readonly {
      readonly request: { readonly method: string; readonly url: string };
      readonly response: { readonly status: number };
    }[];
  };
};

export type RouteCount = {
  readonly path: string;
  readonly requests: number;
  readonly ok: number;
  readonly clientError: number;
  readonly serverError: number;
};

export type Disagreement = {
  readonly code: string;
  readonly title: string;
  readonly count: number;
  readonly operations: readonly string[];
};

export type RunSummary = {
  readonly routes: readonly RouteCount[];
  /** Allowlisted routes that never answered 2xx: the probe did not really check them. */
  readonly unchecked: readonly string[];
  readonly disagreements: readonly Disagreement[];
  readonly errors: number;
  /** Ways the run left its scope; any entry makes the run invalid. */
  readonly scope: readonly string[];
};

export function summarize(
  report: RunReport,
  har: Har,
  allowlist: readonly string[],
  origin: string,
): RunSummary {
  const scope: string[] = [];
  for (const filter of report.warnings?.["unmatched_filter"] ?? [])
    scope.push(`filter matched nothing: ${filter}`);
  if (report.operations?.selected !== allowlist.length)
    scope.push(
      `selected ${report.operations?.selected ?? "?"} operations, allowlist has ${allowlist.length}`,
    );

  const counts = new Map(
    allowlist.map((path) => [path, { requests: 0, ok: 0, clientError: 0, serverError: 0 }]),
  );
  const outside = new Set<string>();
  for (const { request, response } of har.log.entries) {
    const url = new URL(request.url);
    const count = counts.get(url.pathname);
    if (request.method !== "GET") outside.add(`method ${request.method}`);
    if (url.origin !== origin) outside.add(`origin ${url.origin}`);
    if (count === undefined) {
      outside.add(`route ${url.pathname}`);
      continue;
    }
    count.requests += 1;
    if (response.status >= 200 && response.status < 300) count.ok += 1;
    else if (response.status >= 400 && response.status < 500) count.clientError += 1;
    else if (response.status >= 500) count.serverError += 1;
  }
  for (const what of [...outside].sort()) scope.push(`request outside scope: ${what}`);

  const routes = [...counts].map(([path, count]) => ({ path, ...count }));
  return {
    routes,
    unchecked: routes.filter((route) => route.ok === 0).map((route) => route.path),
    disagreements: (report.failures ?? []).map((failure) => ({
      code: failure.code ?? "?",
      title: failure.title ?? "?",
      count: failure.count ?? 0,
      operations: [...(failure.operations ?? [])].sort(),
    })),
    errors: report.errors?.length ?? 0,
    scope,
  };
}

/** The summary as plain text lines, for the console and the recorded run. */
export function formatSummary(summary: RunSummary): string {
  const lines = [
    `Rute: ${summary.routes.length}, provjerene (barem jedan 2xx): ${summary.routes.length - summary.unchecked.length}`,
    `Zahtjeva: ${summary.routes.reduce((sum, route) => sum + route.requests, 0)}`,
    "",
    "ruta | zahtjeva | 2xx | 4xx | 5xx",
    ...summary.routes.map(
      (route) =>
        `${route.path} | ${route.requests} | ${route.ok} | ${route.clientError} | ${route.serverError}`,
    ),
    "",
    `Neslaganja: ${summary.disagreements.length}`,
    ...summary.disagreements.map(
      (item) => `- ${item.code} ${item.title} (${item.count}): ${item.operations.join(", ")}`,
    ),
    `Greške pokretanja: ${summary.errors}`,
  ];
  if (summary.unchecked.length > 0)
    lines.push(`Nisu provjerene (0 × 2xx): ${summary.unchecked.join(", ")}`);
  if (summary.scope.length > 0)
    lines.push("IZVAN OPSEGA, pokret ne vrijedi:", ...summary.scope.map((item) => `- ${item}`));
  return lines.join("\n");
}
