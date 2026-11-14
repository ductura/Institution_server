import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { localPlugin } from "./scripts/lint-rules/index.ts";

// Lint covers the whole repository. Only tool output is ignored; there is no
// per-folder exception list. Inline directives are off: an `eslint-disable`
// comment cannot switch a rule off, and `pnpm lint` fails on the warning it
// leaves (--max-warnings 0), so nothing is silenced quietly.
// Property names an external protocol fixes on the wire. A closed list of exact
// names, each with its standard; it is not a folder exception and covers only
// properties, never variables, functions or types.
const WIRE_NAMES = [
  "logout_token", // OpenID Connect Back-Channel Logout 1.0, section 2.5
];
// ESTree node types: ESLint fixes them as the method names of a rule visitor
// (scripts/lint-rules). A closed list of exact names, only for object-literal
// methods, never variables, functions or types.
const ESTREE_NODE_NAMES = [
  "Program",
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "CallExpression",
  "TSImportType",
  "TSExternalModuleReference",
];

export default defineConfig(
  { ignores: ["**/node_modules/", "**/dist/", "**/coverage/"] },
  {
    linterOptions: { noInlineConfig: true },
    plugins: { "@typescript-eslint": tseslint.plugin, local: localPlugin },
    languageOptions: { parser: tseslint.parser, sourceType: "module", ecmaVersion: "latest" },
  },
  {
    // Any script extension other than lowercase .ts, in any letter case (x.TS, x.Js).
    files: ["**/*.{[cCmM],}[jJtT][sS]{[xX],}"],
    ignores: ["**/*.ts"],
    rules: { "local/only-ts": "error" },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "local/kebab-case-filename": "error",
      "local/test-file-suffix": "error",
      "local/import-boundary": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "enum is not allowed; use a union of literals." },
      ],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["camelCase"] },
        { selector: "variable", format: ["camelCase", "PascalCase", "UPPER_CASE"] },
        { selector: "typeLike", format: ["PascalCase"] },
        {
          selector: ["property", "method", "accessor"],
          modifiers: ["requiresQuotes"],
          format: null,
        },
        {
          selector: "property",
          filter: { regex: `^(?:${WIRE_NAMES.join("|")})$`, match: true },
          format: null,
        },
        {
          selector: "objectLiteralMethod",
          filter: { regex: `^(?:${ESTREE_NODE_NAMES.join("|")})$`, match: true },
          format: null,
        },
      ],
    },
  },
);
