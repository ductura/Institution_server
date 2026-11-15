import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import ts from "typescript";

import {
  CONTRACTS,
  REGISTRY,
  REPOSITORY_URL,
  TEST_ONLY_PACKAGES,
  type PackageSpec,
} from "./manifest.ts";

// Stages a package for `npm publish` (U10, DAN-742): TypeScript compiled to
// JavaScript with declarations, the data files, and a package.json written
// here. The package.json in the repository stays private, so publishing from
// the working tree fails.

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const STAGE_DIR = join(ROOT, "dist", "release");

type SourceManifest = {
  readonly version: string;
  readonly description: string;
  readonly dependencies?: Readonly<Record<string, string>>;
};

const EXACT = "^\\d+\\.\\d+\\.\\d+$";
const Strict = { additionalProperties: false };

// The whole publish manifest: no other field (private, bin, directories,
// peer, optional or bundled dependencies, imports, main), and publishConfig is
// the registry alone, since pnpm and yarn would publish its other fields.
const PublishManifestSchema = Type.Object(
  {
    name: Type.String({ pattern: "^@ductura/[a-z0-9-]+$" }),
    version: Type.String({ pattern: EXACT }),
    description: Type.String(),
    type: Type.Literal("module"),
    exports: Type.Record(
      Type.String(),
      Type.Union([
        Type.Object({ types: Type.String(), default: Type.String() }, Strict),
        // A data file only: code always comes with its declarations.
        Type.String({ pattern: "\\.json$" }),
      ]),
    ),
    files: Type.Array(Type.String()),
    dependencies: Type.Record(Type.String(), Type.String({ pattern: EXACT })),
    publishConfig: Type.Object({ registry: Type.Literal(REGISTRY) }, Strict),
    repository: Type.Object(
      { type: Type.Literal("git"), url: Type.Literal(REPOSITORY_URL), directory: Type.String() },
      Strict,
    ),
  },
  Strict,
);
export type PublishManifest = Static<typeof PublishManifestSchema>;

const toJs = (source: string): string => `./${source.replace(/\.ts$/u, ".js")}`;
const toDts = (source: string): string => `./${source.replace(/\.ts$/u, ".d.ts")}`;

export function publishManifest(spec: PackageSpec, source: SourceManifest): PublishManifest {
  const dependencies: Record<string, string> = {};
  for (const name of spec.dependencies) {
    const version = source.dependencies?.[name];
    if (version === undefined) throw new Error(`${spec.name}: no version for ${name}`);
    dependencies[name] = version;
  }
  return {
    name: spec.name,
    version: source.version,
    description: source.description,
    type: "module",
    exports: {
      ...Object.fromEntries(
        Object.entries(spec.exports).map(([path, file]) => [
          path,
          { types: toDts(file), default: toJs(file) },
        ]),
      ),
      ...spec.dataExports,
    },
    files: spec.files.filter((path) => path !== "package.json"),
    dependencies,
    publishConfig: { registry: REGISTRY },
    repository: { type: "git", url: REPOSITORY_URL, directory: spec.dir },
  };
}

/** Every way `manifest` (parsed JSON) is not fit to publish as `spec`. */
export function manifestErrors(spec: PackageSpec, manifest: unknown): string[] {
  const shape = [...Value.Errors(PublishManifestSchema, manifest)].map(
    (error) => `manifest ${error.path || "/"}: ${error.message}`,
  );
  if (shape.length > 0) return shape;
  const own = manifest as PublishManifest;
  const errors: string[] = [];
  if (own.name !== spec.name) errors.push(`manifest names ${own.name}`);
  if ("./pglite" in own.exports) errors.push("exports /pglite");
  for (const [path, target] of Object.entries(own.exports))
    for (const file of typeof target === "string" ? [target] : [target.types, target.default])
      if (!spec.files.includes(file.replace(/^\.\//u, "")))
        errors.push(`export ${path} points to ${file}, not in the package`);
  for (const name of Object.keys(own.dependencies)) {
    if (!spec.dependencies.includes(name)) errors.push(`unexpected dependency ${name}`);
    if (spec === CONTRACTS && TEST_ONLY_PACKAGES.includes(name))
      errors.push(`contracts depend on ${name}`);
  }
  return errors;
}

function compile(spec: PackageSpec, outDir: string): void {
  const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram(
    Object.values(spec.exports).map((file) => join(ROOT, file)),
    {
      ...parsed.options,
      noEmit: false,
      allowImportingTsExtensions: false,
      rewriteRelativeImportExtensions: true,
      declaration: true,
      sourceMap: false,
      declarationMap: false,
      rootDir: ROOT,
      outDir,
    },
  );
  const emitted = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...emitted.diagnostics];
  if (diagnostics.length > 0 || emitted.emitSkipped)
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => ROOT,
        getNewLine: () => "\n",
      }),
    );
}

/** Stages `spec` under `stageDir` and returns the package folder. */
export function stagePackage(spec: PackageSpec, stageDir = STAGE_DIR): string {
  const out = join(stageDir, spec.name.replace(/^@ductura\//u, ""));
  rmSync(out, { recursive: true, force: true });
  compile(spec, out);
  for (const [target, source] of Object.entries(spec.data)) {
    mkdirSync(dirname(join(out, target)), { recursive: true });
    copyFileSync(join(ROOT, source), join(out, target));
  }
  const source = JSON.parse(
    readFileSync(join(ROOT, spec.dir, "package.json"), "utf8"),
  ) as SourceManifest;
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify(publishManifest(spec, source), null, 2)}\n`,
  );
  return out;
}
