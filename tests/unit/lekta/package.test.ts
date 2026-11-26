import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  loadFpzgPackageV1,
  parseLektaPackage,
  ruleById,
} from "../../../server/domain/lekta/index.ts";

const loaded = loadFpzgPackageV1();
if (!loaded.ok) throw new Error("the shipped package must be valid");
const pkg = loaded.value;
const clone = () => structuredClone(JSON.parse(JSON.stringify(pkg))) as Record<string, any>;

describe("Lekta FPZG package v1", () => {
  it("loads and carries its version and commit", () => {
    expect(pkg.packageVersion).toBe("1.0.0");
    expect(pkg.lektaCommit).toBe("c445a7193f08");
    expect(pkg.pravila.length).toBeGreaterThan(20);
  });

  it("gives a rule by id and nothing for an unknown id", () => {
    expect(ruleById(pkg, "fpzg.tekst.prored")?.vrijednost).toBe(1.5);
    expect(ruleById(pkg, "fpzg.tekst.font")?.vrijednost).toEqual(["Times New Roman"]);
    expect(ruleById(pkg, "fpzg.ne.postoji")).toBeUndefined();
  });

  it("covers page, font, spacing, scope, parts, cover fields and citation style", () => {
    for (const id of [
      "fpzg.stranica.margine_cm",
      "fpzg.tekst.font",
      "fpzg.tekst.prored",
      "fpzg.opseg.diplomski",
      "fpzg.struktura.obavezni_dijelovi",
      "fpzg.naslovnica.polja",
      "fpzg.citat.stil",
    ])
      expect(ruleById(pkg, id), id).toBeDefined();
  });

  it("every rule has a Croatian description and a source file", () => {
    for (const rule of pkg.pravila) {
      expect(rule.opis.length, rule.id).toBeGreaterThan(10);
      expect(
        pkg.izvori.some((s) => s.datoteka === rule.izvor.datoteka),
        rule.id,
      ).toBe(true);
    }
  });
});

describe("rejects an invalid package", () => {
  const cases: [string, (p: Record<string, any>) => void][] = [
    ["bad version", (p) => (p.packageVersion = "1.0")],
    ["bad commit", (p) => (p.lektaCommit = "xyz")],
    ["missing sources", (p) => (p.izvori = [])],
    ["bad hash", (p) => (p.izvori[0].sha256 = "abc")],
    ["duplicate source", (p) => p.izvori.push({ ...p.izvori[0] })],
    ["duplicate rule id", (p) => (p.pravila[1].id = p.pravila[0].id)],
    ["bad rule id", (p) => (p.pravila[0].id = "Bad Id")],
    ["empty description", (p) => (p.pravila[0].opis = " ")],
    ["unknown status", (p) => (p.pravila[0].status = "mozda")],
    ["rule cites an unlisted file", (p) => (p.pravila[0].izvor.datoteka = "x.md")],
    ["missing value", (p) => delete p.pravila[0].vrijednost],
  ];
  it.each(cases)("%s", (_name, mutate) => {
    const raw = clone();
    mutate(raw);
    const result = parseLektaPackage(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LEKTA_PACKAGE_INVALID");
  });

  it.each([null, 5, "x", [], {}])("%j", (raw) => {
    expect(parseLektaPackage(raw).ok).toBe(false);
  });
});

describe("drift: recorded sha256 of the sources matches the fixture", () => {
  const sha = (file: string) =>
    createHash("sha256")
      .update(
        readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8").replace(/\r/g, ""),
      )
      .digest("hex");

  it("every source of the package has a fixture with the recorded hash", () => {
    for (const source of pkg.izvori) {
      const name = source.datoteka.split("/").pop() as string;
      expect(sha(name), source.datoteka).toBe(source.sha256);
    }
  });

  it("a changed source is detected", () => {
    const source = pkg.izvori[0] as { datoteka: string; sha256: string };
    const name = source.datoteka.split("/").pop() as string;
    const changed = createHash("sha256")
      .update(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8") + " ")
      .digest("hex");
    expect(changed).not.toBe(source.sha256);
  });
});
