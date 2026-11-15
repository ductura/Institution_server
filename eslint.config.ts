import type { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import prettierOff from "eslint-config-prettier";
import tseslint from "typescript-eslint";
import { databaseBoundaryPlugin, localPlugin, PG_SPECIFIER } from "./scripts/lint-rules/index.ts";

// Lint covers the whole repository. Only tool output is ignored; there is no
// per-folder exception list. Inline directives are off: an `eslint-disable`
// comment cannot switch a rule off, and `pnpm lint` fails on the warning it
// leaves (--max-warnings 0), so nothing is silenced quietly.
// Property names an external protocol fixes on the wire. A closed list of exact
// names, each with its standard; it is not a folder exception and covers only
// properties, never variables, functions or types.
const WIRE_NAMES = [
  "logout_token", // OpenID Connect Back-Channel Logout 1.0, section 2.5
  // OAuth 2.0 (RFC 6749): authorization request, token request and response, errors.
  "client_id",
  "client_secret",
  "redirect_uri",
  "response_type",
  "grant_type",
  "access_token",
  "error_description",
  "code_challenge", // RFC 7636 (PKCE), section 4.3
  "code_challenge_method", // RFC 7636 (PKCE), section 4.3
  "code_verifier", // RFC 7636 (PKCE), section 4.5
  "id_token", // OpenID Connect Core 1.0, section 3.1.3.3
  "given_name", // OpenID Connect Core 1.0, section 5.1 (standard claims)
  "family_name", // OpenID Connect Core 1.0, section 5.1 (standard claims)
  // OpenID Connect Dynamic Client Registration 1.0, section 2 (client metadata).
  "redirect_uris",
  "token_endpoint_auth_method",
  "post_logout_redirect_uris", // OpenID Connect RP-Initiated Logout 1.0, section 3.1
  "backchannel_logout_uri", // OpenID Connect Back-Channel Logout 1.0, section 2.2
  "backchannel_logout_session_required", // OpenID Connect Back-Channel Logout 1.0, section 2.2
  // S-0.18 (DAN-731), the login core ported from Ductus src/server/auth and its test provider.
  "token_type", // RFC 6749, section 5.1
  "expires_in", // RFC 6749, section 5.1
  "key_ops", // RFC 7517 (JWK), section 4.3
  "id_token_signed_response_alg", // OpenID Connect Dynamic Client Registration 1.0, section 2
  "post_logout_redirect_uri", // OpenID Connect RP-Initiated Logout 1.0, section 2
  "end_session_endpoint", // OpenID Connect RP-Initiated Logout 1.0, section 2.1
  // OpenID Connect Discovery 1.0, section 3 (provider metadata).
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
  "response_types_supported",
  "subject_types_supported",
  "id_token_signing_alg_values_supported",
  "code_challenge_methods_supported", // RFC 8414, section 2
  // JWS algorithm names as keys of the pinned-algorithm table (RFC 7518 section 3.1; EdDSA RFC 8037).
  "RS256",
  "PS256",
  "ES256",
  "EdDSA",
];
// Names fixed outside this repository that are not wire names: process
// environment variables, the oidc-provider configuration keys (Configuration
// "ttl") and one PostgreSQL connection parameter. A closed list of exact names,
// only for properties.
// "application_name" is the node-postgres client option named after the
// PostgreSQL connection parameter (libpq, "Parameter Key Words").
const FIXED_NAMES = ["NODE_ENV", "PORT", "IdToken", "AccessToken", "application_name"];
// Process environment variables of the local database scripts (S-0.14,
// scripts/db/native-db.ts and its tests): the DUCTUS_* names come from Ductus,
// the others are the libpq, psql and dbmate variables those scripts strip or
// set. A closed list of exact names, only for properties.
const ENV_NAMES = [
  "DUCTUS_NATIVE_PGHOST",
  "DUCTUS_NATIVE_PGPORT",
  "DUCTUS_NATIVE_PGSOCKET",
  "DUCTUS_NATIVE_PGUSER",
  "DUCTUS_NATIVE_PGDATABASE",
  "DUCTUS_NATIVE_PGPASSWORD",
  "DUCTUS_AUTH_LOCAL_PASSWORD",
  "DUCTUS_WORKER_LOCAL_PASSWORD",
  "PGHOST",
  "PGPASSWORD",
  "PGPASSFILE",
  "PSQLRC",
  "DBMATE_URL",
  "DATABASE_URL",
  "PATH",
  // The login of the web process and the startup check (S-0.17,
  // server/config, server/database), and a variable that check must not ask for.
  "APP_DATABASE_URL",
  "DUCTUS_AUTH_PROVIDER",
  // Login configuration (S-0.18, server/external/srce-auth/config.ts), names from Ductus.
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI",
  "OIDC_CLOCK_TOLERANCE_SECONDS",
  "OIDC_ID_TOKEN_ALG",
];
// Result columns of PostgreSQL rows that the migration tests in tests/db read
// and compare as they come from pg: column names of db/main/migrations (ported
// verbatim, D-91) and one alias of a test query (app_can_select). The tests are
// ported from Ductus with the same assertions (S-0.13, DAN-726), so the rows
// keep their snake_case keys. A closed list of exact names, for properties and
// for a destructured binding of such a property, never other names.
const COLUMN_NAMES = [
  "accepts_evidence",
  "ai_policy",
  "ai_purposes",
  "app_can_select",
  "content_hash",
  "created_at",
  "current_version",
  "document_id",
  "event_key",
  "evidence_profile",
  "expires_at",
  "import_allowed",
  "institution_id",
  "last_seen_at",
  "published_at",
  "published_by",
  "recipient_id",
  "student_id",
  "target_id",
  "updated_at",
  "version_no",
  "work_type",
];
// S-0.17 (DAN-730): names that only server/database and its database tests
// (tests/db) may use, the one place where snake_case meets the code
// (docs/CODE_STYLE.md, rule 9). The code and tests are ported from Ductus
// src/server/db and tests/integration with the same assertions. A closed list
// of exact names, for properties and destructured bindings, in those two
// folders only.
const DATABASE_NAMES = [
  // node-postgres pool options (appPoolConfig); the last two are also
  // PostgreSQL connection parameters and settings read back in a test.
  "query_timeout",
  "statement_timeout",
  "idle_in_transaction_session_timeout",
  // Result columns and aliases of the statements and of their tests.
  "advisory_locks",
  "app_role",
  "has_password",
  "same_tx",
  "server_version",
  "token_set",
  "user_id",
  // The alias of the institution slug in the current-actor statement
  // (current-actor.ts, S-0.18, DAN-731).
  "institution_slug",
  // PostgreSQL setting names (pg_settings.name) that the log-settings check
  // reads; its tests state them as the keys of a settings row.
  "log_statement",
  "log_min_duration_statement",
  "log_min_duration_sample",
  "log_statement_sample_rate",
  "log_transaction_sample_rate",
  "log_parameter_max_length",
  "log_parameter_max_length_on_error",
  "log_min_error_statement",
  "debug_print_parse",
  "debug_print_rewritten",
  "debug_print_plan",
  // SQL keywords that the withActor tests (with-actor.test.ts) use as the
  // prefix of a statement whose answer a fake pool replaces.
  "COMMIT",
  "DISCARD",
  "ROLLBACK",
];
// Keys the redact tests feed in as sensitive input, in the letter case and
// spelling a caller could send them: the test is that redact drops their
// values whatever the spelling. Only in server/log.
const REDACTION_INPUT_KEYS = [
  "Authorization",
  "AUTHORIZATION",
  "set_cookie",
  "Snapshot",
  "first_name",
  "Surname",
  "OIB",
  "Tekst",
  "Prezime",
  "Naslov",
];
// AWS KMS API field names (AWS KMS API Reference: Sign, Verify, GetPublicKey),
// which the AWS SDK (@aws-sdk/client-kms) takes and returns as they are. The
// keys adapter is ported from Ductus src/adapters/crypto (S-0.19, DAN-732). A
// closed list of exact names, only for properties, only in server/external/keys
// and its fake KMS in test-support/fake-kms.
const AWS_KMS_NAMES = [
  "KeyId",
  "KeySpec",
  "KeyUsage",
  "Message",
  "MessageType",
  "PublicKey",
  "Signature",
  "SignatureValid",
  "SigningAlgorithm",
  "SigningAlgorithms",
];
// S-0.19 (DAN-732): names in server/external/storage, ported from Ductus
// src/adapters/evidence at d52a92c3 with the same assertions. Only in that
// folder; a closed list of exact names, only for properties.
const STORAGE_NAMES = [
  // Amazon S3 API Reference, "Error responses" (error codes the adapter maps
  // to fixed reasons).
  "RequestTimeTooSkewed",
  "SignatureDoesNotMatch",
  "AuthorizationHeaderMalformed",
  "InvalidAccessKeyId",
  // The header name as the AWS SigV4 test suite writes it (s3-signature.test.ts).
  "Host",
  // Invented credential variables of the storage configuration tests.
  "EVIDENCE_S3_FAK_A_KEY_ID",
  "EVIDENCE_S3_FAK_A_SECRET",
  "EVIDENCE_S3_FAK_B_KEY_ID",
  "EVIDENCE_S3_FAK_B_SECRET",
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

// The naming rule, with extra exact property names (`properties`) and extra
// exact destructured names (`destructured`) for the folders of one block.
// Test code, which may use the contract fake server (local/no-fake-server-import).
const TEST_ONLY_FILES = [
  "**/*.test.ts",
  "server/test-server/**",
  "test-support/**",
  "packages/test-fakes/**",
];

function namingConvention(properties: string[], destructured: string[]): Linter.RuleEntry {
  return [
    "error",
    { selector: "default", format: ["camelCase"] },
    { selector: "variable", format: ["camelCase", "PascalCase", "UPPER_CASE"] },
    { selector: "typeLike", format: ["PascalCase"] },
    // A leading underscore marks a parameter the function does not read
    // (`_`, `_name`), as in the code ported from Ductus (S-0.17).
    { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
    {
      selector: ["property", "method", "accessor"],
      modifiers: ["requiresQuotes"],
      format: null,
    },
    {
      selector: "property",
      filter: {
        regex: `^(?:${[...WIRE_NAMES, ...FIXED_NAMES, ...ENV_NAMES, ...COLUMN_NAMES, ...properties].join("|")})$`,
        match: true,
      },
      format: null,
    },
    {
      selector: ["variable", "parameter"],
      modifiers: ["destructured"],
      filter: { regex: `^(?:${[...COLUMN_NAMES, ...destructured].join("|")})$`, match: true },
      format: null,
    },
    {
      selector: "objectLiteralMethod",
      filter: { regex: `^(?:${ESTREE_NODE_NAMES.join("|")})$`, match: true },
      format: null,
    },
  ];
}

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
      // Areas import each other only as docs/server-map.md §2 allows (S-1A-b).
      "local/area-boundary": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "enum is not allowed; use a union of literals." },
      ],
      "@typescript-eslint/naming-convention": namingConvention([], []),
    },
  },
  {
    // PLAN §3, rule 3: routes.ts holds no logic, only route declarations. The
    // enum ban is repeated because these options replace the block above.
    files: ["server/**/routes.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "enum is not allowed; use a union of literals." },
        ...[
          "IfStatement",
          "SwitchStatement",
          "ForStatement",
          "ForInStatement",
          "ForOfStatement",
          "WhileStatement",
          "DoWhileStatement",
          "TryStatement",
          "ConditionalExpression",
          "AwaitExpression",
        ].map((selector) => ({ selector, message: "routes.ts holds no logic (PLAN §3, rule 3)." })),
      ],
    },
  },
  {
    // snake_case meets the code only here (docs/CODE_STYLE.md, rule 9).
    files: ["server/database/**/*.ts", "tests/db/**/*.ts"],
    rules: {
      "@typescript-eslint/naming-convention": namingConvention(DATABASE_NAMES, DATABASE_NAMES),
    },
  },
  {
    files: ["server/external/storage/**/*.ts"],
    rules: { "@typescript-eslint/naming-convention": namingConvention(STORAGE_NAMES, []) },
  },
  {
    files: ["server/log/**/*.ts"],
    rules: { "@typescript-eslint/naming-convention": namingConvention(REDACTION_INPUT_KEYS, []) },
  },
  {
    files: ["server/external/keys/**/*.ts", "test-support/fake-kms/**/*.ts"],
    rules: { "@typescript-eslint/naming-convention": namingConvention(AWS_KMS_NAMES, []) },
  },
  // The database driver stays behind server/database (PLAN §3, rule 4; Ductus
  // eslint.config.mjs at d52a92c3, S-0.17). This development guard covers
  // literal specifiers in static imports, import() and calls such as require;
  // it does not resolve computed ones. Inline directives are off (above).
  {
    files: ["**/*.ts"],
    plugins: { "database-boundary": databaseBoundaryPlugin },
    rules: {
      "database-boundary/no-restricted-dynamic-imports": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { regex: PG_SPECIFIER, message: "Database access goes through server/database only." },
          ],
        },
      ],
    },
  },
  {
    // The database tests check the database directly. The session-GUC guard
    // (server/database/session-guc-scope.test.ts) is inside server/database.
    files: ["server/database/**", "tests/db/**"],
    rules: {
      "no-restricted-imports": "off",
      "database-boundary/no-restricted-dynamic-imports": "off",
    },
  },
  {
    // The fake server from the contracts (U8) answers with made-up vectors and
    // never reaches production code. Its own rule, so the database exception
    // to no-restricted-imports below or above cannot switch it off.
    // server/contracts/fake-server.test.ts also walks the import graph of the
    // production entry point.
    files: ["**/*.ts"],
    ignores: TEST_ONLY_FILES,
    rules: { "local/no-fake-server-import": "error" },
  },
  // Last on purpose: switches off every rule that could fight Prettier, also in
  // blocks above. tests/format/format.test.ts checks the resolved config.
  prettierOff,
);
