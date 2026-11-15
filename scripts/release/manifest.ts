// What each published package is (U10, DAN-742): its entry points, data files
// and the exact list of files in its tarball. A file that is not listed here
// does not get published; scripts/release/check.ts compares the list with
// `npm pack --dry-run --json` of the staged package.

export const REGISTRY = "https://npm.pkg.github.com";
export const REPOSITORY_URL = "git+https://github.com/ductura/server.git";

export type PackageSpec = {
  readonly name: string;
  /** The package folder in this repository. */
  readonly dir: string;
  /** Published subpath → source file (repository path). */
  readonly exports: Readonly<Record<string, string>>;
  /** Published subpath → data file (tarball path), exported as it is. */
  readonly dataExports: Readonly<Record<string, string>>;
  /** Tarball path → source file (repository path), copied as they are. */
  readonly data: Readonly<Record<string, string>>;
  /** Dependencies of the source package.json that are published. */
  readonly dependencies: readonly string[];
  /** Exactly the files of the tarball. */
  readonly files: readonly string[];
};

const js = (...paths: string[]): string[] =>
  paths.flatMap((path) => [`${path}.js`, `${path}.d.ts`]);

const GENERATED = "server/contracts/generated";

export const CONTRACTS: PackageSpec = {
  name: "@ductura/contracts",
  dir: "packages/contracts",
  exports: { ".": "packages/contracts/index.ts" },
  // The contract document itself, info.version included, for clients and tools.
  dataExports: { "./openapi/v1.json": "./openapi/v1.json" },
  data: { "openapi/v1.json": "openapi/v1.json", "README.md": "packages/contracts/README.md" },
  dependencies: [],
  files: [
    "README.md",
    "openapi/v1.json",
    "package.json",
    ...js(
      "packages/contracts/index",
      `${GENERATED}/client`,
      `${GENERATED}/index`,
      `${GENERATED}/types`,
      `${GENERATED}/validate`,
    ),
  ].sort(),
};

const FAKES = "packages/test-fakes";
const MODULES = ["clock", "fake-server", "fido2", "oidc", "services"] as const;

export const TEST_FAKES: PackageSpec = {
  name: "@ductura/test-fakes",
  dir: FAKES,
  // "." is release.ts: index.ts without /pglite (not published in U10).
  exports: {
    ".": `${FAKES}/release.ts`,
    ...Object.fromEntries(MODULES.map((name) => [`./${name}`, `${FAKES}/${name}/index.ts`])),
  },
  dataExports: {},
  data: {
    [`${GENERATED}/fake-server/vectors.json`]: `${GENERATED}/fake-server/vectors.json`,
    "README.md": `${FAKES}/README.md`,
  },
  dependencies: ["oidc-provider"],
  files: [
    "README.md",
    "package.json",
    `${GENERATED}/fake-server/vectors.json`,
    ...js(`${GENERATED}/fake-server/index`, `${FAKES}/release`, `${FAKES}/guard/index`),
    ...MODULES.flatMap((name) => js(`${FAKES}/${name}/index`)),
    ...js(`${FAKES}/clock/clock`, `${FAKES}/fido2/authenticator`, `${FAKES}/services/services`),
    ...js(
      ...["accounts", "guard", "modes", "redirect-uris", "server"].map((f) => `${FAKES}/oidc/${f}`),
    ),
  ].sort(),
};

export const PACKAGES: readonly PackageSpec[] = [CONTRACTS, TEST_FAKES];

/** Never a dependency of the published contracts (clients load it in production). */
export const TEST_ONLY_PACKAGES = ["@ductura/test-fakes", "oidc-provider", "@electric-sql/pglite"];
