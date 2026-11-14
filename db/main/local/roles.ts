// The roles the local provisioning makes, as in Ductus at d52a92c3 (S-0.14,
// DAN-727): db/main/local/migrator.sql makes the migrator and the group roles
// before the first migration, and the three login files make one login each,
// a member of exactly one group role. roles.test.ts holds the SQL files to
// this list; tests/db/local-roles.integration.test.ts holds a database brought up by
// `pnpm db:up:native` to it.

export type RoleAttributes = {
  login: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDb: boolean;
  replication: boolean;
  bypassRls: boolean;
};

const NOTHING: RoleAttributes = {
  login: false,
  superuser: false,
  inherit: true,
  createRole: false,
  createDb: false,
  replication: false,
  bypassRls: false,
};

/** The one role with DDL; NOLOGIN, only CREATEROLE (migrator.sql). */
export const MIGRATOR_ROLE = "ductus_migrator";
export const MIGRATOR_ATTRIBUTES: RoleAttributes = { ...NOTHING, createRole: true };

/** The group roles, in the order of migrator.sql and the roles migration; NOLOGIN, nothing elevated. */
export const GROUP_ROLES: readonly string[] = Object.freeze([
  "ductus_app",
  "ductus_worker",
  "ductus_retention",
  "ductus_evidence",
  "ductus_identity",
  "ductus_auth",
]);

/** Roles the migrations make themselves (20261108110000_pgboss_owner.sql); NOLOGIN, nothing elevated. */
export const MIGRATION_ROLES: readonly string[] = Object.freeze(["ductus_queue"]);

/** Each local login, its file and the one group role it inherits (INHERIT TRUE, SET FALSE). */
export const LOGIN_ROLES: readonly { login: string; file: string; group: string }[] = Object.freeze(
  [
    { login: "ductus_app_local", file: "app-login.sql", group: "ductus_app" },
    { login: "ductus_worker_local", file: "worker-login.sql", group: "ductus_worker" },
    { login: "ductus_auth_local", file: "auth-login.sql", group: "ductus_auth" },
  ],
);
export const LOGIN_ATTRIBUTES: RoleAttributes = { ...NOTHING, login: true };
export const GROUP_ATTRIBUTES: RoleAttributes = NOTHING;
