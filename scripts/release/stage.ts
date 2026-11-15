import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { REGISTRY, REPOSITORY_URL, TEST_ONLY_PACKAGES, type PackageSpec } from "./manifest.ts";

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

export type PublishManifest = {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly type: "module";
  readonly exports: Readonly<Record<string, { readonly types: string; readonly default: string }>>;
  readonly files: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly publishConfig: { readonly registry: string };
  readonly repository: { readonly type: "git"; readonly url: string; readonly directory: string };
};

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
    exports: Object.fromEntries(
      Object.entries(spec.exports).map(([path, file]) => [
        path,
        { types: toDts(file), default: toJs(file) },
      ]),
    ),
    files: spec.files.filter((path) => path !== "package.json"),
    dependencies,
    publishConfig: { registry: REGISTRY },
    repository: { type: "git", url: REPOSITORY_URL, directory: spec.dir },
  };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

/** Every way `manifest` (as parsed JSON) is not fit to publish as `spec`. */
export function manifestErrors(spec: PackageSpec, manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if ("private" in manifest) errors.push("private is set");
  if ("bin" in manifest || "scripts" in manifest) errors.push("bin or scripts is set");
  if (manifest.name !== spec.name || !spec.name.startsWith("@ductura/"))
    errors.push("name is not the package name in @ductura");
  const config = manifest.publishConfig as { registry?: unknown } | undefined;
  if (config?.registry !== REGISTRY) errors.push(`registry is not ${REGISTRY}`);
  const repository = manifest.repository as { url?: unknown } | undefined;
  if (repository?.url !== REPOSITORY_URL) errors.push("repository is not ductura/server");
  const exports = (manifest.exports ?? {}) as Record<string, Record<string, string>>;
  if ("./pglite" in exports) errors.push("exports /pglite");
  for (const [path, target] of Object.entries(exports))
    for (const file of Object.values(target))
      if (!spec.files.includes(file.replace(/^\.\//u, "")))
        errors.push(`export ${path} points to ${file}, not in the package`);
  const dependencies = (manifest.dependencies ?? {}) as Record<string, unknown>;
  for (const [name, version] of Object.entries(dependencies)) {
    if (!spec.dependencies.includes(name)) errors.push(`unexpected dependency ${name}`);
    if (typeof version !== "string" || !EXACT_VERSION.test(version))
      errors.push(`dependency ${name} has no exact version`);
  }
  if (spec.name === "@ductura/contracts")
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"])
      for (const name of Object.keys((manifest[field] ?? {}) as object))
        if (TEST_ONLY_PACKAGES.includes(name)) errors.push(`contracts depend on ${name}`);
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
