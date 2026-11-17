// DAN-911-1 (S-M-2): Ductus config/institutions.json at b36c82b, the same
// content. A .ts module, not .json: every relative import names a .ts file
// (scripts/lint-rules/import-boundary.ts), and the build bundles it into
// dist/server.js, the only file of the infra/web image. Typed `unknown`: the
// file earns its shape only through institutionsProblems (institutions.ts).
export const INSTITUTIONS_FILE: unknown = {
  format: "ductus-institutions-v1",
  institutions: [
    { slug: "fpzg", citationStyle: "fpzg" },
    { slug: "demo-fakultet", citationStyle: "fpzg" },
    { slug: "demo-fakultet-b", citationStyle: "fpzg" },
  ],
};
