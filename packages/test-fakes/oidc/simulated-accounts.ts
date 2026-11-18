// Invented accounts of any institution's domain (Ductus#2028, contract §3.5),
// next to the fixed demo accounts of accounts.ts. Local development and CI
// only (D-09): the provider that serves them refuses to start elsewhere
// (guard.ts). Once an institution with home organisation X exists, a student
// or a teacher of X can sign in through the simulator without a code change.
//
// Two sources:
// - the login page form (domain, role, user name). The account id carries
//   everything, `sim:<role>:<user>@<domain>`, so the provider keeps no state;
// - a JSON file (FAKE_OIDC_ACCOUNTS_FILE, `pnpm lokalno` passes
//   .local/oidc-racuni.json) with named accounts, shown as buttons.
// Every name here is invented; nothing is a real person.
import { readFileSync } from "node:fs";

import type { DemoAccountClaims } from "./accounts.ts";

/** The roles of the form: AAI@EduHr releases `student` or `djelatnik` (hrEdu004). */
export const SIMULATED_ROLES = Object.freeze({
  student: "student",
  nastavnik: "djelatnik",
} as const);
export type SimulatedRole = keyof typeof SIMULATED_ROLES;

export type SimulatedAccount = {
  readonly role: SimulatedRole;
  readonly user: string;
  readonly domain: string;
  readonly givenName: string;
  readonly familyName: string;
};

const PREFIX = "sim";
// A lower-case DNS name of at least two labels, at most 253 characters.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?=.{3,253}$)${LABEL}(?:\\.${LABEL})+$`, "u");
const USER_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
// Letters (any script), spaces, hyphens and apostrophes; 1 to 64 characters.
const NAME_RE = /^[\p{L}][\p{L} '-]{0,63}$/u;

const isRole = (value: unknown): value is SimulatedRole =>
  typeof value === "string" && Object.hasOwn(SIMULATED_ROLES, value);

/** True for a lower-case domain of two or more labels (`fpzg.hr`). */
export const isSimulatedDomain = (value: unknown): value is string =>
  typeof value === "string" && DOMAIN_RE.test(value);

/** True for a user name of lower-case letters, digits, `.`, `_` and `-`. */
export const isSimulatedUser = (value: unknown): value is string =>
  typeof value === "string" && USER_RE.test(value);

/** The account id of a simulated account: `sim:<role>:<user>@<domain>`. */
export function simulatedAccountId(account: Pick<SimulatedAccount, "role" | "user" | "domain">) {
  return `${PREFIX}:${account.role}:${account.user}@${account.domain}`;
}

/** The default names of a form account: "Simulirani student", "Simulirani nastavnik". */
function defaultNames(role: SimulatedRole): { givenName: string; familyName: string } {
  return { givenName: "Simulirani", familyName: role === "student" ? "Student" : "Nastavnik" };
}

/**
 * The account of the login form, or undefined when a field is not valid. An
 * empty user name takes the role's name (`student`, `nastavnik`).
 */
export function simulatedAccountFromForm(form: URLSearchParams): SimulatedAccount | undefined {
  const role = form.get("uloga");
  const domain = form.get("domena")?.trim().toLowerCase();
  const typed = form.get("korisnik")?.trim().toLowerCase() ?? "";
  if (!isRole(role) || !isSimulatedDomain(domain)) return undefined;
  const user = typed === "" ? role : typed;
  if (!isSimulatedUser(user)) return undefined;
  return { role, user, domain, ...defaultNames(role) };
}

/** The account an id names, with the default names, or undefined. */
export function parseSimulatedAccountId(id: unknown): SimulatedAccount | undefined {
  if (typeof id !== "string") return undefined;
  const match = /^sim:([a-z]+):([^@]+)@(.+)$/u.exec(id);
  if (match === null) return undefined;
  const [, role, user, domain] = match;
  if (!isRole(role) || !isSimulatedUser(user) || !isSimulatedDomain(domain)) return undefined;
  return { role, user, domain, ...defaultNames(role) };
}

/** The claims of a simulated account, in the shape AAI@EduHr releases (accounts.ts). */
export function simulatedAccountClaims(account: SimulatedAccount): DemoAccountClaims {
  const id = simulatedAccountId(account);
  return {
    sub: id,
    name: `${account.givenName} ${account.familyName}`,
    given_name: account.givenName,
    family_name: account.familyName,
    hrEduPersonUniqueID: [`${account.user}@${account.domain}`],
    hrEduPersonHomeOrg: [account.domain],
    hrEduPersonAffiliation: [SIMULATED_ROLES[account.role]],
  };
}

function field(entry: Record<string, unknown>, name: string, at: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(entry, name);
  if (descriptor !== undefined && !("value" in descriptor))
    throw new Error(`${at}.${name} is not a plain value`);
  return descriptor?.value;
}

const ACCOUNT_KEYS = new Set(["korisnik", "domena", "uloga", "ime", "prezime"]);

/**
 * The accounts of the JSON file: `{ "racuni": [{ "korisnik", "domena",
 * "uloga", "ime"?, "prezime"? }] }`. Throws with the position of the first
 * bad entry; unknown keys and duplicate accounts are refused.
 */
export function parseSimulatedAccountsFile(input: unknown): SimulatedAccount[] {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("accounts file: the root is not an object");
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "racuni")
    throw new Error('accounts file: the root has exactly one key, "racuni"');
  const list = field(input as Record<string, unknown>, "racuni", "racuni");
  if (!Array.isArray(list)) throw new Error("accounts file: racuni is not an array");
  if (list.length > 200) throw new Error("accounts file: more than 200 accounts");
  const seen = new Set<string>();
  return list.map((item: unknown, index) => {
    const at = `racuni[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error(`accounts file: ${at} is not an object`);
    const entry = item as Record<string, unknown>;
    const unknownKey = Object.keys(entry).find((key) => !ACCOUNT_KEYS.has(key));
    if (unknownKey !== undefined) throw new Error(`accounts file: ${at} has an unknown key`);
    const role = field(entry, "uloga", at);
    const domain = field(entry, "domena", at);
    const user = field(entry, "korisnik", at);
    if (!isRole(role)) throw new Error(`accounts file: ${at}.uloga is student or nastavnik`);
    if (!isSimulatedDomain(domain)) throw new Error(`accounts file: ${at}.domena is not a domain`);
    if (!isSimulatedUser(user)) throw new Error(`accounts file: ${at}.korisnik is not valid`);
    const names = defaultNames(role);
    const given = field(entry, "ime", at) ?? names.givenName;
    const family = field(entry, "prezime", at) ?? names.familyName;
    if (typeof given !== "string" || !NAME_RE.test(given))
      throw new Error(`accounts file: ${at}.ime is not a name`);
    if (typeof family !== "string" || !NAME_RE.test(family))
      throw new Error(`accounts file: ${at}.prezime is not a name`);
    const account = { role, user, domain, givenName: given, familyName: family };
    const id = simulatedAccountId(account);
    if (seen.has(id)) throw new Error(`accounts file: ${at} repeats an account`);
    seen.add(id);
    return Object.freeze(account);
  });
}

/** Reads and checks the accounts file; an unset path is no accounts. */
export function readSimulatedAccountsFile(path: string | undefined): SimulatedAccount[] {
  if (path === undefined || path.trim() === "") return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = Reflect.get(error as object, "code");
    throw new Error(`accounts file cannot be read (${String(code)})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("accounts file is not JSON");
  }
  return parseSimulatedAccountsFile(parsed);
}

/**
 * The claims of an account id: a file account by its id (with its names), a
 * form account by the id alone, anything else undefined.
 */
export function simulatedClaimsFor(
  id: unknown,
  fileAccounts: readonly SimulatedAccount[],
): DemoAccountClaims | undefined {
  const parsed = parseSimulatedAccountId(id);
  if (parsed === undefined) return undefined;
  const named = fileAccounts.find((account) => simulatedAccountId(account) === id);
  return simulatedAccountClaims(named ?? parsed);
}
