// SRV-M4-LEKTA-FPZG: the excerpt of the FPZG rule package taken from Lekta
// (read only, a fixed commit). Pure: no I/O. `parseLektaPackage` validates a
// parsed JSON value, `loadFpzgPackageV1` returns the validated package that
// ships in fpzg-v1.json, `ruleById` looks a rule up by its id.
import fpzgV1 from "./fpzg-v1.json" with { type: "json" };
import type { AppError, Result } from "../result.ts";

export type LektaSource = { datoteka: string; sha256: string };
export type LektaRule = {
  id: string;
  podrucje: string;
  opis: string;
  vrijednost: unknown;
  status: "potvrdeno" | "nepotvrdeno";
  izvor: { datoteka: string; lokator: string };
};
export type LektaPackage = {
  packageVersion: string;
  lektaCommit: string;
  jezik: "hr";
  fakultet: string;
  izvori: LektaSource[];
  pravila: LektaRule[];
};

const SEMVER = /^\d+\.\d+\.\d+$/;
const COMMIT = /^[0-9a-f]{12,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RULE_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
const STATUSES = new Set(["potvrdeno", "nepotvrdeno"]);

const bad = (reason: string): Result<never> => ({
  ok: false,
  error: {
    code: "LEKTA_PACKAGE_INVALID",
    messageKey: "lekta.package.invalid",
    ...{ reason },
  } as AppError,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export function parseLektaPackage(raw: unknown): Result<LektaPackage> {
  if (!isRecord(raw)) return bad("not an object");
  if (!text(raw.packageVersion) || !SEMVER.test(raw.packageVersion)) return bad("packageVersion");
  if (!text(raw.lektaCommit) || !COMMIT.test(raw.lektaCommit)) return bad("lektaCommit");
  if (raw.jezik !== "hr") return bad("jezik");
  if (!text(raw.fakultet)) return bad("fakultet");
  if (!Array.isArray(raw.izvori) || raw.izvori.length === 0) return bad("izvori");
  const files = new Set<string>();
  const izvori: LektaSource[] = [];
  for (const item of raw.izvori as unknown[]) {
    if (!isRecord(item) || !text(item.datoteka) || !text(item.sha256) || !SHA256.test(item.sha256))
      return bad("izvor");
    if (files.has(item.datoteka)) return bad(`duplicate izvor ${item.datoteka}`);
    files.add(item.datoteka);
    izvori.push({ datoteka: item.datoteka, sha256: item.sha256 });
  }
  if (!Array.isArray(raw.pravila) || raw.pravila.length === 0) return bad("pravila");
  const ids = new Set<string>();
  const pravila: LektaRule[] = [];
  for (const item of raw.pravila as unknown[]) {
    if (!isRecord(item)) return bad("rule");
    if (!text(item.id) || !RULE_ID.test(item.id)) return bad("rule id");
    if (ids.has(item.id)) return bad(`duplicate rule ${item.id}`);
    ids.add(item.id);
    if (!text(item.podrucje) || !text(item.opis)) return bad(`rule ${item.id} text`);
    if (typeof item.status !== "string" || !STATUSES.has(item.status))
      return bad(`rule ${item.id} status`);
    if (item.vrijednost === undefined) return bad(`rule ${item.id} vrijednost`);
    const izvor = item.izvor;
    if (!isRecord(izvor) || !text(izvor.datoteka) || !text(izvor.lokator))
      return bad(`rule ${item.id} izvor`);
    if (!files.has(izvor.datoteka)) return bad(`rule ${item.id} cites an unlisted file`);
    pravila.push({
      id: item.id,
      podrucje: item.podrucje,
      opis: item.opis,
      vrijednost: item.vrijednost,
      status: item.status as LektaRule["status"],
      izvor: { datoteka: izvor.datoteka, lokator: izvor.lokator },
    });
  }
  return {
    ok: true,
    value: {
      packageVersion: raw.packageVersion,
      lektaCommit: raw.lektaCommit,
      jezik: "hr",
      fakultet: raw.fakultet,
      izvori,
      pravila,
    },
  };
}

export function ruleById(pkg: LektaPackage, id: string): LektaRule | undefined {
  return pkg.pravila.find((rule) => rule.id === id);
}

export function loadFpzgPackageV1(): Result<LektaPackage> {
  return parseLektaPackage(fpzgV1);
}
