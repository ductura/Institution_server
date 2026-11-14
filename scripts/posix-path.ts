/**
 * A file-system path with forward slashes only. `fileURLToPath` and
 * `path.relative` return backslashes on Windows; comparisons against a
 * repository path such as `openapi/v1.json` must go through this first.
 */
export function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}
