// Markdown link checking helpers for the docs link test.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type DocLink = { file: string; target: string };

const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Relative inline links only: web URLs and mail links are skipped; bare anchors (#x) are kept. */
export function extractRelativeLinks(markdown: string): string[] {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links: string[] = [];
  for (const match of withoutCode.matchAll(LINK_PATTERN)) {
    const target = match[1];
    if (target && !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) links.push(target);
  }
  return links;
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to dashes. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export function headingSlugs(markdown: string): Set<string> {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const slugs = new Set<string>();
  for (const match of withoutCode.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    if (match[1]) slugs.add(slugify(match[1]));
  }
  return slugs;
}

export function listMarkdownFiles(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) out.push(path);
    }
  };
  for (const entry of dirs) {
    const path = join(root, entry);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) walk(path);
    else out.push(path);
  }
  return out;
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Returns a description of every link in the files that does not resolve. */
export function findBrokenLinks(files: string[]): string[] {
  const broken: string[] = [];
  for (const file of files) {
    const markdown = readFileSync(file, "utf8");
    for (const link of extractRelativeLinks(markdown)) {
      const [pathPart = "", anchor] = link.split("#");
      const targetFile = pathPart === "" ? file : resolve(dirname(file), safeDecode(pathPart));
      if (!existsSync(targetFile)) {
        broken.push(`${file}: ${link} (missing file)`);
        continue;
      }
      if (anchor && targetFile.endsWith(".md") && statSync(targetFile).isFile()) {
        if (!headingSlugs(readFileSync(targetFile, "utf8")).has(anchor)) {
          broken.push(`${file}: ${link} (missing anchor)`);
        }
      }
    }
  }
  return broken;
}
