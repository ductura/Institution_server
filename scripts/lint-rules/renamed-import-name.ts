import type { Rule } from "eslint";

// @typescript-eslint/naming-convention checks default and namespace imports
// only, never a named one (its `import` selector), so `import { a as bad_name }`
// would pass. This rule closes that gap for a name this repository chooses: the
// local name of a renamed import, the public name of a renamed export, and the
// name of `export * as` and of `import x =`, which naming-convention also skips.
// A name kept as another module wrote it (`import { snake_name }`) is not checked.
// The three checks mirror the predefined formats of naming-convention
// (camelCase, PascalCase, UPPER_CASE; no leading or trailing underscore).

function isCamelCase(name: string): boolean {
  return name[0] === name[0]?.toLowerCase() && !name.includes("_");
}

function isPascalCase(name: string): boolean {
  return name[0] === name[0]?.toUpperCase() && !name.includes("_");
}

function isUpperCase(name: string): boolean {
  return name === name.toUpperCase() && !/^_|_$|__/.test(name);
}

/** The local or public name is camelCase, PascalCase or UPPER_CASE. */
export function isAllowedAlias(name: string): boolean {
  return name.length > 0 && (isCamelCase(name) || isPascalCase(name) || isUpperCase(name));
}

type ModuleName = { type: "Identifier"; name: string } | { type: "Literal"; value?: unknown };

function nameOf(node: ModuleName): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

// A string module name that is also a valid identifier (`as "bad_b"`): an
// importer then writes it unchanged (`import { bad_b }`), so it is checked here.
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*$/u;

/** The name a renamed export publishes, or null when no identifier is chosen. */
function exportedName(node: ModuleName): string | null {
  const name = nameOf(node);
  return name !== "default" && IDENTIFIER.test(name) ? name : null;
}

/** A renamed import or export uses an allowed name. */
export const renamedImportName: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "A renamed import or export is camelCase, PascalCase or UPPER_CASE" },
    messages: {
      alias:
        "Renamed name '{{name}}' must be camelCase, PascalCase or UPPER_CASE (docs/CODE_STYLE.md §2).",
    },
    schema: [],
  },
  create(context) {
    const check = (node: Rule.Node, name: string | null): void => {
      if (name !== null && !isAllowedAlias(name)) {
        context.report({ node, messageId: "alias", data: { name } });
      }
    };
    return {
      ImportSpecifier(node) {
        if (nameOf(node.imported) !== node.local.name) {
          check(node.local as Rule.Node, node.local.name);
        }
      },
      ExportSpecifier(node) {
        // `as default` and a string that is not an identifier (`as "x-y"`) are
        // not names this repository spells.
        const name = exportedName(node.exported);
        if (name !== nameOf(node.local)) {
          check(node.exported as Rule.Node, name);
        }
      },
      // `export * as ns from`: naming-convention has no selector for it.
      ExportAllDeclaration(node) {
        if (node.exported) {
          check(node.exported as Rule.Node, exportedName(node.exported));
        }
      },
      // `import x = require("…")`, `import x = Ns.m` and `export import`:
      // naming-convention does not check the name either.
      TSImportEqualsDeclaration(node: Rule.Node & { id: { name: string } }) {
        check(node, node.id.name);
      },
    } as Rule.RuleListener;
  },
};
