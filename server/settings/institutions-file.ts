// DAN-911-1 (S-M-2): Ductus config/institutions.json at b36c82b, the same
// content. A .ts module, not .json: every relative import names a .ts file
// (scripts/lint-rules/import-boundary.ts), and the build bundles it into
// dist/server.js, the only file of the infra/web image. Typed `unknown`: the
// file earns its shape only through institutionsProblems (institutions.ts).
// It is checked at start and never read at login: open_session finds the
// institution in the database by its home organisation, so an institution
// provisioned later (POST /internal/v1/institutions, Ductus#2028
// c.6993786629 §2) signs in without a restart and without a line here
// (tests/db/institution-provisioning-route.integration.test.ts).
export const INSTITUTIONS_FILE: unknown = {
  format: "ductus-institutions-v1",
  institutions: [
    { slug: "fpzg", citationStyle: "fpzg" },
    { slug: "demo-fakultet", citationStyle: "fpzg" },
    { slug: "demo-fakultet-b", citationStyle: "fpzg" },
  ],
};
