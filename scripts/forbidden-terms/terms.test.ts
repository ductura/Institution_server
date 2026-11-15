// Ported from Ductus at d52a92c3 (S-1L.1, DAN-768, PR-b1): the cases of
// tests/unit/forbidden-terms.test.ts that call findForbiddenTerms (lines 34-226,
// 961-977, 1264-1486 without the markup readings, 1728-1784), all of
// tests/unit/forbidden-terms-dictionary-forms.test.ts and the findForbiddenTerms
// half of tests/unit/forbidden-terms-review-regression.test.ts. Cases that the
// §5 deltas of terms.ts turn from allowed into flagged are moved to the flagged
// lists with a "§5 delta N" note; describe "§5 deltas" holds the new cases.
import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_TERMS,
  PHRASE_BREAK,
  findForbiddenTerms,
  foldPhrases,
  foldText,
} from "./terms.ts";

const entries = (text: string) => findForbiddenTerms(text).map((term) => term.entry);

describe("forbidden interface terms (PRODUCT.md §5)", () => {
  it.each([
    ["Sumnjivo lijepljenje", "sumnjivo"],
    ["Postoji sumnja na prepisivanje", "sumnjivo"],
    ["Nesumnjivo je tako", "sumnjivo"],
    ["Ocjena rizika: visoka", "rizik"],
    ["Rizični odlomci", "rizik"],
    ["Uočena ANOMALIJA u zapisu", "anomalija, anomaly"],
    ["Upozorenje o studentu", "upozorenje o studentu"],
    ["Upozorenja o studentima", "upozorenje o studentu"],
    ["Postotak AI-ja: 40 %", "AI postotak"],
    ["AI-postotak", "AI postotak"],
    ["Vjerojatnost umjetne inteligencije", "vjerojatnost"],
    ["Autentičnost rada", "autentičnost"],
    ["autenticnost", "autentičnost"],
    ["Ovo je napisao AI", "napisao AI"],
    ["Napisala umjetna inteligencija", "napisao AI"],
    ["AI je napisao odlomak", "napisao AI"],
    ["Verificirano autorstvo", "verificirano autorstvo"],
    ["Dokaz autorstva", "dokaz autorstva"],
    ["Kopirani tekst", "kopirano"],
    ["Prepisano iz izvora", "prepisano"],
    ["Nestali podaci", "nestali podaci"],
    ["Skriveni dio rada", "skriveno"],
    ["Spremljeno", "spremljeno (bez pojašnjenja)"],
    ["Promjene su spremljene.", "spremljeno (bez pojašnjenja)"],
    ["Suspicious paste", "suspicious"],
    ["Risk score", "risk"],
    ["AI percentage", "AI percentage"],
    ["Percentage of AI", "AI percentage"],
    ["Probability of AI use", "probability"],
    ["Authenticity check", "authenticity"],
    ["Written by AI", "written by AI"],
    ["Verified authorship", "verified authorship"],
    ["Proof of authorship", "proof of authorship"],
    ["Copied text", "copied"],
    ["Missing data", "missing data"],
    ["Hidden edits", "hidden"],
    // Derived forms: the stem may sit inside a word.
    ["Posumnjati u rad", "sumnjivo"],
    ["Osumnjičen", "sumnjivo"],
    ["Nerizičan rad", "rizik"],
    ["Neautentično", "autentičnost"],
    ["Inauthentic", "authenticity"],
    // English equivalents (D-90, point 3).
    ["Suspected paste", "suspicious"],
    ["Likelihood of AI use", "probability"],
    ["Warning about the student", "warning about the student"],
    ["Warnings about students", "warning about the student"],
    ["Alert regarding this student", "warning about the student"],
    ["Student warning", "warning about the student"],
    ["Student alerts", "warning about the student"],
    ["Saved", "saved (without saying where)"],
    ["All changes saved.", "saved (without saying where)"],
    ["Saved locally", "saved (without saying where)"],
    ["Spremljeno lokalno", "spremljeno (bez pojašnjenja)"],
  ])("flags %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });

  // Gender, number and case of each entry, and the forms derived from it.
  it.each([
    ["Sumnjivih odlomaka", "sumnjivo"],
    ["Bez sumnji", "sumnjivo"],
    ["Rizici", "rizik"],
    ["Visokorizični odlomci", "rizik"],
    ["Anomalije u zapisu", "anomalija, anomaly"],
    ["Anomalan zapis", "anomalija, anomaly"],
    ["Upozorenjima o studenticama", "upozorenje o studentu"],
    ["Postotak umjetne inteligencije: 40 %", "AI postotak"],
    ["Postoci AI-ja", "AI postotak"],
    ["Postotkom AI-ja", "AI postotak"],
    ["AI postoci", "AI postotak"],
    ["S vjerojatnošću od 80 %", "vjerojatnost"],
    ["Rad je autentičan", "autentičnost"],
    ["Autentičnošću rada", "autentičnost"],
    ["Napisao ga je AI", "napisao AI"],
    ["AI ga je napisao", "napisao AI"],
    ["Umjetna inteligencija je napisala odlomak", "napisao AI"],
    ["Verificiranog autorstva", "verificirano autorstvo"],
    ["Dokaz o autorstvu", "dokaz autorstva"],
    ["Kopirana rečenica", "kopirano"],
    ["Prekopirano", "kopirano"],
    ["Iskopiran odlomak", "kopirano"],
    ["Prepisani odlomci", "prepisano"],
    ["Nestalim podacima", "nestali podaci"],
    ["Nestao podatak", "nestali podaci"],
    ["Skrivenih dijelova", "skriveno"],
    ["Spremljena verzija", "spremljeno (bez pojašnjenja)"],
    ["Suspiciously fast", "suspicious"],
    ["Risky paragraphs", "risk"],
    ["Anomalous edits", "anomaly"],
    ["Alerts on students", "warning about the student"],
    ["Percentage of artificial intelligence", "AI percentage"],
    ["Authentically written", "authenticity"],
    ["AI-generated text", "written by AI"],
    ["AI wrote this paragraph", "written by AI"],
    ["Proofs of authorship", "proof of authorship"],
    ["Copy-pasted", "copied"],
  ])("flags the form %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });

  it("tells Croatian entries from English ones", () => {
    for (const term of FORBIDDEN_TERMS) expect(["hr", "en"], term.entry).toContain(term.lang);
    const croatian = (text: string) => findForbiddenTerms(text, "hr").map((term) => term.entry);
    expect(croatian("Hidden risk, anomaly, saved")).toEqual([]);
    expect(croatian("Hidden rizik")).toEqual(["rizik"]);
    expect(findForbiddenTerms("Hidden rizik", "en").map((term) => term.entry)).toEqual(["hidden"]);
    expect(entries("Hidden rizik")).toEqual(["rizik", "hidden"]);
  });

  it.each([
    "Authenticated",
    "Authenticator app",
    "Postotak riješenih zadataka",
    "Kopija rada",
    "Umjetna inteligencija nije dopuštena u ovom zadatku",
    "AI pomoćnik je napisao prijedlog",
    "Spremljeno na uređaju",
    "Spremljeno na poslužitelju",
    "spremljeno na uredaju",
    "Predano",
    "Nespremljene promjene",
    "Spremi",
    "Zalijepljeno (izvor nije opažen)",
    "Praznina u zapisu",
    "Zapis je cjelovit i neizmijenjen od primitka",
    "Iz AI pomoćnika (model, 14:05)",
    "Kako je rad nastao, bez presude o autorstvu.",
    "Autentikacija nije uspjela",
    "Authentication failed",
    "Prijava putem AAI@EduHr",
    "Dokazi o predaji",
    "Kristina je napisala uvod",
    // Words that only resemble `sumnj` once diacritics are folded away.
    "Razumniji prijedlog",
    "Šumniji prostor",
    "Sumarni pregled",
    "Sum njihovih radova",
    "Saved on this device",
    "Saved on the server",
    "Saved to your device",
    "Unsaved changes",
    "Save",
    "Submitted",
    "Warning about the deadline",
    "Notice to students",
    "Asterisk marks a required field",
    "Briefly",
  ])("allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });

  it("matches across case, diacritics, punctuation and invisible characters", () => {
    expect(foldText("AUTENTIČNOST")).toBe("autenticnost");
    expect(foldText("Skri­ven")).toBe("skriven");
    expect(foldText("Đak  –  rizik!")).toBe("dak rizik");
    expect(entries("dokaz autorstva")).toEqual(["dokaz autorstva"]);
    expect(entries("Ｓｕｍｎｊｉｖｏ")).toEqual(["sumnjivo"]);
    expect(entries("sum​njivo")).toEqual(["sumnjivo"]);
  });

  it("gives every entry a replacement from the dictionary", () => {
    for (const term of FORBIDDEN_TERMS) expect(term.instead).not.toBe("");
  });

  it("gives every contextual entry the word alone as a literal that covers every form the entry covers", () => {
    const forms = ["spremljeno", "spremljena", "spremljen", "spremljenih", "saved"];
    for (const term of FORBIDDEN_TERMS) {
      const word = term.contextual?.word;
      if (!word) continue;
      expect(word.flags, term.entry).toBe("u");
      const covered = forms.filter((form) => term.pattern.test(form));
      expect(covered.length, term.entry).toBeGreaterThan(0);
      for (const form of covered) {
        expect(word.test(`${form} na uredaju`), form).toBe(true);
        expect(word.test(`ne${form}`), form).toBe(false);
        expect(word.test(`${form}9`), form).toBe(false);
      }
    }
  });
});

// Owner decisions on #179 (DAN-134), 12. 10. 2026.: the dictionary covers every
// form of the same root except the allowed actions, the A and B tables of #179
// are accepted as written, and the English equivalents are listed one by one.
describe("dictionary forms and synonyms (#179)", () => {
  it.each([
    ["Student je kopirao odlomak", "kopirano"],
    ["Kopirala je uvod", "kopirano"],
    ["Tekst se ne smije kopirati", "kopirano"],
    ["Kopiranje teksta", "kopirano"],
    ["Prepisao je odlomak", "prepisano"],
    ["Prepisivanje iz izvora", "prepisano"],
    ["Prepiši verziju", "prepisano"],
    ["Autenticitet rada", "autentičnost"],
    ["Sakriveni dio", "skriveno"],
    ["Prikriveno lijepljenje", "skriveno"],
    ["Vjerojatan izvor", "vjerojatnost"],
    ["Udio AI-ja", "AI postotak"],
    ["AI: 78 %", "AI postotak"],
    ["78 % AI", "AI postotak"],
    ["Postotak ljudskosti", "AI postotak"],
    ["Ljudski udio", "AI postotak"],
    ["Udio izvora X", "AI postotak"],
    ["Podaci su nestali", "nestali podaci"],
    ["Autorstvo je verificirano", "verificirano autorstvo"],
    ["Upozorenje o ovom studentu", "upozorenje o studentu"],
    ["Plagijat", "plagijat"],
    ["Plagirano poglavlje", "plagijat"],
    ["Izvornost rada", "izvornost"],
    ["Originalnost teksta", "izvornost"],
    ["Provjera integriteta", "integritet"],
    ["Neobično brzo pisanje", "neobično"],
    ["Neuobičajeni obrasci", "neobično"],
    ["Nepravilnost u radu", "nepravilnost"],
    ["Tuđe riječi", "tuđi tekst"],
    ["Tekst nije njegov", "tuđi tekst"],
    ["Odlomak nije vlastiti", "tuđi tekst"],
    ["Ljudski napisano", "napisao čovjek"],
    ["Napisao ga je čovjek", "napisao čovjek"],
    ["Copying detected", "copied"],
    ["Copy-paste", "copied"],
    ["Doubtful passage", "suspicious"],
    ["Low-risk", "risk"],
    ["Riskless", "risk"],
    ["Probably offline", "probability"],
    ["AI share", "AI percentage"],
    ["78 % human", "AI percentage"],
    ["Plagiarized", "plagiarism"],
    ["Unoriginal", "originality"],
    ["Integrity check", "integrity"],
    ["Atypical", "unusual"],
    ["Irregularity", "irregularity"],
    ["Concealed", "hidden"],
    ["Human-written", "written by a human"],
    ["Someone else's text", "someone else's text"],
  ])("flags %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });

  // Section C of #179, without the cases §5 deltas 1, 2 and 4 now flag.
  it.each([
    "Kopiraj navod",
    "Kopiranje navoda",
    "Kopirano u međuspremnik",
    "Navod je u međuspremniku",
    "Kopija rada",
    "Copy citation",
    "Sakrij panel",
    "Preuzmi PDF",
    "Preuzeto",
    "Odstupanje od pravila citatnog stila",
    "Izvorni oblik",
    "Originalna datoteka",
    "Napredak 40 %",
    "Učitavanje 80 %",
    "Nedostaje naslov",
    "Nedostaje izvor",
    "Prijepis razgovora",
    "Propisano pravilnikom",
    "Nepravilan format datoteke",
    "Ductus ne procjenjuje autorstvo ni korištenje AI-ja.",
    "Cjelovitost zapisa",
    "Original file",
    "Transcript",
  ])("allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });
});

describe("dictionary review regressions (DAN-134)", () => {
  it.each([
    "Nije njegov red",
    "Nije njen uređaj",
    "Za ovo nije vlastiti uređaj",
    "Nije njegov radni prostor",
    "Tuđi tekstualni uređivač",
    "Datoteke nisu njezine",
    "This is not her own WordPress account",
    "Someone else's wordpress",
    "Podaci su nestandardnog formata",
    "Nije njezin odlomačni prikaz",
    "U ovoj prepisci nema poruka",
    "This is not their own device",
  ])("allows neutral UI action or phrase %j", (text) => {
    expect(findForbiddenTerms(text)).toEqual([]);
  });

  it.each([
    ["Copied from a document", "copied"],
    ["Copied to clipboardX", "copied"],
    ["Copied. To clipboard settings.", "copied"],
    ["Kopirano. U međuspremniku nema sadržaja.", "kopirano"],
    ["Kopirano\nU međuspremnik", "kopirano"],
    ["Kopiranje. Navoda nema.", "kopirano"],
    ["This is not their own text", "someone else's text"],
    ["Nije njegov tekst", "tuđi tekst"],
    ["Riječi nisu njegove", "tuđi tekst"],
    ["Nisu vlastiti tekstovi", "tuđi tekst"],
    ["Tuđim riječima", "tuđi tekst"],
    ["Podaci nestaju", "nestali podaci"],
    ["Procjena vjerojatnog AI podrijetla", "vjerojatnost"],
    ["Vjerojatnoga izvora", "vjerojatnost"],
    ["Nije njezina odlomka", "tuđi tekst"],
    ["Nije vlastiti rad", "tuđi tekst"],
    ["Najvjerojatnije", "vjerojatnost"],
    ["Naj​vjerojatnije", "vjerojatnost"],
  ])("still flags %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });
});

describe("phrase boundary of the contextual entries", () => {
  const HR = "spremljeno (bez pojašnjenja)";
  const EN = "saved (without saying where)";

  it.each([
    ["Spremljeno. Na uređaju nema drugih promjena.", HR],
    ["Spremljeno, na poslužitelju još nije.", HR],
    ["Spremljeno\nNa uređaju", HR],
    ["Spremljeno na (uređaju)", HR],
    ["Spremljeno na svakom uređaju", HR],
    ["Spremljeno​na uređaju", HR],
    ["Na uređaju: spremljeno", HR],
    ["Spremljeno na uređaju. Spremljeno.", HR],
    ["Spremljeno1", HR],
    ["Saved. On the server: 2 changes waiting.", EN],
    ["Saved — on the server nothing yet.", EN],
    ["Saved on the new server", EN],
    ["Saved. Saved on this device.", EN],
    ["Saved2", EN],
  ])("flags %j", (text, entry) => {
    expect(entries(text)).toEqual([entry]);
  });

  it.each([
    "Spremljeno na uređaju.",
    "Spremljeno na poslužitelju, predano.",
    "Spremljeno na uređaju (prije 2 minute)",
    "„Spremljeno na poslužitelju”",
    "Nije spremljeno na uređaju",
    "Spremljeno na uređaju. Spremljeno na poslužitelju. Predano.",
    "Saved on this device.",
    "Saved to your device (2 minutes ago)",
    "Saved on this device. Saved on the server. Submitted.",
  ])("allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });

  it("keeps where a phrase ends in the folded text of a contextual entry, and only there", () => {
    expect(PHRASE_BREAK).not.toMatch(/[ \p{L}\p{N}]/u);
    expect(foldPhrases("Spremljeno. Na uređaju")).toBe(`spremljeno${PHRASE_BREAK}na uredaju`);
    expect(foldPhrases("  Spremljeno \t na uređaju.  ")).toBe("spremljeno na uredaju");
    expect(foldPhrases(" – ")).toBe("");
    expect(entries("Nestali. Podaci")).toEqual(["nestali podaci"]);
    expect(entries("Verified\nauthorship")).toEqual(["verified authorship"]);
  });
});

describe("the rizik entry in compounds", () => {
  const rizik = (text: string) => entries(text).includes("rizik");

  it.each(["Srednjerizičan rad", "Bezrizično", "Niskorizični rad", "SREDNJERIZIČAN", "rizicima"])(
    "flags %j",
    (text) => {
      expect(rizik(text)).toBe(true);
    },
  );

  // "križić" (a small cross) is the one common word with the letters.
  it.each(["Križić", "Kliknite na križić za zatvaranje", "Horizont", "Arizona", "Rizoto"])(
    "does not flag %j",
    (text) => {
      expect(rizik(text)).toBe(false);
    },
  );

  // Known false positive, recorded so the behaviour is deliberate.
  it("flags the invented surname Brizić", () => {
    expect(rizik("Brizić")).toBe(true);
  });

  it("keeps the English entry bound to the start of a word (brisk, asterisk)", () => {
    expect(entries("Asterisk")).toEqual([]);
    expect(entries("Brisk walk")).toEqual([]);
    expect(entries("High risk")).toContain("risk");
  });
});

// Contract Ductus#1836 c.6890523605, confirmed in c.6890541239: where Ductus and
// the literal docs/PRODUCT.md §5 differ, the stricter side holds.
describe("§5 deltas", () => {
  // Delta 1: "kopir-" only in the three allowed actions, in exactly those words.
  it.each([
    "Kopiraj navod",
    "KOPIRAJ NAVOD",
    "kopiranje navoda",
    "Kopirano u međuspremnik.",
    "KOPIRANO U MEDUSPREMNIK",
  ])("delta 1 allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });

  it.each([
    "Kopiraj",
    "Kopiraj tekst",
    "Kopirajte navod",
    "Kopirajte",
    "Kopirajmo",
    "Kopiraj navode",
    "Kopiraj. Navod",
    "Prekopiraj navod",
    "Kopiranjem navoda",
    "Kopirano u međuspremniku",
    "Kopirana u međuspremnik",
  ])("delta 1 flags %j", (text) => {
    expect(entries(text)).toContain("kopirano");
  });

  // Delta 2: "copy" only in "Copy citation".
  it.each(["Copy citation", "COPY CITATION", "Copy citation"])("delta 2 allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });

  it.each([
    "Copy",
    "Copy text",
    "Copied",
    "Copied to clipboard",
    "Copied to the clipboard.",
    "Cop​ied to clipboard",
    "copies",
    "copying",
    "copyright",
    "Copy. Citation",
    "Copy citations",
    "Copy\ncitation",
  ])("delta 2 flags %j", (text) => {
    expect(entries(text)).toContain("copied");
  });

  it.each(["Coping", "Copper", "Kopija teksta", "Cope with it"])(
    "delta 2 leaves other words alone: %j",
    (text) => {
      expect(entries(text)).toEqual([]);
    },
  );

  // Delta 3: the adverb "vjerojatno" and every other form of the root.
  it.each(["Vjerojatno offline", "Nevjerojatno iskustvo", "vjerojatno"])(
    "delta 3 flags %j",
    (text) => {
      expect(entries(text)).toContain("vjerojatnost");
    },
  );

  // Delta 4: the rows with a condition are checked always.
  it.each([
    ["Nedostajući podaci", "nedostajući podaci"],
    ["Izgubljeni podaci mogu se vratiti na ovom uređaju", "nedostajući podaci"],
    ["Podaci su izgubljeni", "nedostajući podaci"],
    ["Podaci nedostaju", "nedostajući podaci"],
    ["Lost data can be recovered on this device", "missing data"],
    ["Data was lost", "missing data"],
    ["Some data is missing", "missing data"],
    ["Nepravilno", "nepravilnost"],
    ["Misconduct", "cheating, dishonest, misconduct"],
    ["Flagged", "flagged, flagged for review"],
  ])("delta 4 flags %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });

  it.each(["Nedostaje naslov", "Nepravilan format", "Nepravilna oznaka datuma", "Lost connection"])(
    "delta 4 allows %j",
    (text) => {
      expect(entries(text)).toEqual([]);
    },
  );

  // Delta 5: "vanished data" and the additional English list of D-276.
  it.each([
    ["Vanished data", "vanished data"],
    ["The data has vanished", "vanished data"],
    ["Trust score", "risk score, trust score, attention score, suspicion score"],
    ["Attention scores", "risk score, trust score, attention score, suspicion score"],
    ["Suspicion score", "risk score, trust score, attention score, suspicion score"],
    ["Cheating", "cheating, dishonest, misconduct"],
    ["Cheated", "cheating, dishonest, misconduct"],
    ["Dishonesty", "cheating, dishonest, misconduct"],
    ["AI-detected", "AI-detected, flagged as AI"],
    ["Detected as AI", "AI-detected, flagged as AI"],
    ["Flagged as AI", "AI-detected, flagged as AI"],
    ["Flagged for review", "flagged, flagged for review"],
    ["Flags", "flagged, flagged for review"],
    ["Flagging", "flagged, flagged for review"],
  ])("delta 5 flags %j as %s", (text, entry) => {
    expect(entries(text)).toContain(entry);
  });

  it.each([
    "Score",
    "Trust this device",
    "Flagship course",
    "Change detected",
    "Data saved on the server",
  ])("delta 5 allows %j", (text) => {
    expect(entries(text)).toEqual([]);
  });
});
