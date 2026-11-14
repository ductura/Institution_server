import path from "node:path";
import type { Rule } from "eslint";

type Node = Rule.Node;
type Source = { type: string; value?: unknown; expressions?: unknown[]; quasis?: { value: { cooked?: string | null } }[] };

/** The literal text of an import source, or null when it is not a static string. */
function staticText(source: Source | null | undefined): string | null {
  if (!source) return null;
  if (source.type === "Literal" && typeof source.value === "string") return source.value;
  if (source.type === "TemplateLiteral" && source.expressions?.length === 0) {
    return source.quasis?.[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * A relative import that leaves the importing file's folder must name exactly
 * `<folder>/index.ts`: another folder is reached only through its index.
 * Package and `node:` imports are not checked. A dynamic import whose source
 * is not a static string cannot be checked and is reported.
 */
export const importBoundary: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Another folder is imported only through its index.ts" },
    messages: {
      boundary: "Import '{{spec}}' reaches into another folder; import its index.ts instead.",
      extension: "Relative import '{{spec}}' must name a .ts file.",
      dynamic: "Dynamic import with a computed source cannot be checked; use a static string.",
      form: "Import '{{spec}}' uses a form the boundary check cannot verify (absolute, file:, or containing \\, ?, # or %).",
    },
    schema: [],
  },
  create(context) {
    const from = path.dirname(context.filename);

    function check(node: Node, spec: string): void {
      // Node and TypeScript read "\\" as "/" and strip "?" and "#"; path.resolve does not.
      const relative = /^\.\.?(?:[/\\]|$)/.test(spec);
      if (/^(?:\/|file:)/i.test(spec) || (relative && /[\\?#%]/.test(spec))) {
        context.report({ node, messageId: "form", data: { spec } });
        return;
      }
      if (!relative) return;
      if (!spec.endsWith(".ts")) {
        context.report({ node, messageId: "extension", data: { spec } });
        return;
      }
      const target = path.resolve(from, spec);
      if (path.dirname(target) !== from && path.basename(target) !== "index.ts") {
        context.report({ node, messageId: "boundary", data: { spec } });
      }
    }

    function checkSource(node: Node, source: Source | null | undefined, dynamic: boolean): void {
      const spec = staticText(source);
      if (spec !== null) check(node, spec);
      else if (dynamic) context.report({ node, messageId: "dynamic" });
    }

    return {
      ImportDeclaration: (node) => checkSource(node, node.source, false),
      ExportNamedDeclaration: (node) => checkSource(node, node.source, false),
      ExportAllDeclaration: (node) => checkSource(node, node.source, false),
      ImportExpression: (node) => checkSource(node, node.source as Source, true),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require") {
          checkSource(node, node.arguments[0] as Source | undefined, true);
        }
      },
      // TypeScript-only forms: `typeof import("x")` and `import x = require("x")`.
      TSImportType(node: Node & { source?: Source }) {
        checkSource(node, node.source, true);
      },
      TSExternalModuleReference(node: Node & { expression?: Source }) {
        checkSource(node, node.expression, true);
      },
    };
  },
};
