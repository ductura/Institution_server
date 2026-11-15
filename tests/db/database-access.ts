// S-1F-c (DAN-779): who may reach which database. One validator for the whole
// catalogue of a cluster, not a sample: every role × every checked object ×
// every privilege must be in the input, and a privilege is right only when
// the role holds it exactly when it is, or inherits, a role the policy names.
// tests/db/logs-database.integration.test.ts reads the input from a real
// PostgreSQL; tests/db/database-access.test.ts feeds it wrong catalogues.

/** A role of the cluster and every role whose rights it uses (itself included). */
export type RoleRow = { role: string; superuser: boolean; inherits: readonly string[] };
/** One privilege of one role on one object, as PostgreSQL answers it. */
export type GrantRow = { role: string; object: string; privilege: string; granted: boolean };
/** object → privilege (lower case) → the roles that hold it; anyone else must not. */
export type AccessPolicy = Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;

const DATABASE_PRIVILEGES = ["CONNECT", "CREATE", "TEMPORARY"] as const;
const SCHEMA_PRIVILEGES = ["USAGE", "CREATE"] as const;

/** The policy of one database: its owner holds everything, `connect` may connect and use `public`. */
export function databasePolicy(
  database: string,
  owner: string,
  connect: readonly string[],
): AccessPolicy {
  const all = [owner, ...connect];
  return {
    [`database:${database}`]: { connect: all, create: [owner], temporary: [owner] },
    [`schema:${database}.public`]: { usage: all, create: [owner] },
  };
}

/** The privileges the policy checks on an object (by its kind). */
export function privilegesOf(object: string): readonly string[] {
  return object.startsWith("schema:") ? SCHEMA_PRIVILEGES : DATABASE_PRIVILEGES;
}

/**
 * Errors between the catalogue and the policy, and the number of rows that
 * were checked. A superuser of the cluster is the one role outside the policy.
 */
export function checkDatabaseAccess(
  roles: readonly RoleRow[],
  grants: readonly GrantRow[],
  policy: AccessPolicy,
): { errors: string[]; checked: number } {
  const errors: string[] = [];
  const byRole = new Map(roles.map((row) => [row.role, row]));
  const seen = new Set<string>();
  let checked = 0;
  for (const grant of grants) {
    const key = `${grant.role}|${grant.object}|${grant.privilege}`;
    if (seen.has(key)) {
      errors.push(`${grant.role} ${grant.privilege} on ${grant.object} is in the input twice`);
      continue;
    }
    seen.add(key);
    const role = byRole.get(grant.role);
    const holders = policy[grant.object]?.[grant.privilege.toLowerCase()];
    if (!role) {
      errors.push(`${grant.role} has a privilege row but is not a role of the cluster`);
      continue;
    }
    if (!holders) {
      errors.push(`${grant.privilege} on ${grant.object} is not in the policy`);
      continue;
    }
    checked += 1;
    if (role.superuser) continue;
    const allowed = role.inherits.some((name) => holders.includes(name));
    if (grant.granted && !allowed) {
      errors.push(`${grant.role} has ${grant.privilege} on ${grant.object} and must not`);
    } else if (!grant.granted && allowed) {
      errors.push(`${grant.role} lacks ${grant.privilege} on ${grant.object}`);
    }
  }
  // Every pair must be there: a missing row is never a pass.
  for (const object of Object.keys(policy)) {
    for (const privilege of privilegesOf(object)) {
      for (const { role } of roles) {
        if (!seen.has(`${role}|${object}|${privilege}`)) {
          errors.push(`${role} ${privilege} on ${object} is missing from the input`);
        }
      }
    }
  }
  for (const holders of Object.values(policy).flatMap((entry) => Object.values(entry))) {
    for (const name of holders) {
      if (!byRole.has(name)) errors.push(`${name} is in the policy but not a role of the cluster`);
    }
  }
  if (checked === 0) errors.push("no privilege was checked");
  return { errors, checked };
}
