/**
 * Interface vocabulary that the product never uses (Ductus docs/PRODUCT.md §5,
 * "Rječnik sučelja"), ported from Ductus scripts/forbidden-terms/terms.ts at
 * d52a92c3 (S-1L.1, DAN-768, PR-b1). Not ported: the markup readings
 * (`findForbiddenTermsInMarkup` and its windows) and entities.ts, since
 * locales/ holds no JSX or HTML; the characters check comes with PR-b2.
 * Where Ductus and §5 read word for word differ, the stricter side holds
 * (contract Ductus#1836 c.6890523605, confirmed in c.6890541239); such an
 * entry is marked "§5 delta N".
 *
 * Matching runs on folded text: NFKC, Croatian lower case, diacritics and
 * invisible characters removed, any other run of non-letters turned into one
 * space, so `autentica?n` catches "AUTENTIČNOST" and "autentičan". An entry
 * covers every form of its root, the word orders and synonyms of tables A and
 * B of #179 and its English equivalents (owner, 12. 10. 2026.). The allowed
 * actions of §5 ("Kopiraj navod", "kopiranje navoda", "Kopirano u
 * međuspremnik", "Copy citation", "Sakrij …", progress percentages) stay out of
 * every pattern, in exactly those words.
 */
export type Language = "hr" | "en";

export type ForbiddenTerm = {
  /** Entry from the dictionary table, as written in PRODUCT.md. */
  readonly entry: string;
  /** What the dictionary says to use instead. */
  readonly instead: string;
  /** Language of the forms the pattern matches. */
  readonly lang: Language;
  readonly pattern: RegExp;
  /**
   * Set when the pattern allows the word before certain words ("spremljeno na
   * uređaju"); it is matched on `foldPhrases`. `word` is the word alone, kept
   * from Ductus, where the markup reading uses it.
   */
  readonly contextual?: { readonly word: RegExp };
  /** Set when an allowed phrase must not be put together across a phrase end (`foldPhrases`). */
  readonly readsPhrases?: true;
};

// Patterns are literals. Most keep letters and digits away from both ends of
// the term. `sumnj` and `rizik` match anywhere in a word, so derived forms and
// compounds ("posumnjati", "bezrizično") are caught; "križić" (folded "krizic")
// is the one exception, and invented surnames such as "Brizić" are known false
// positives. The contextual patterns keep only letters away from the word: a
// digit next to it ("Spremljeno 1") does not say where the work was saved.
const NOTHING = "(ništa; činjenice se prikazuju bez oznake)";
const AI_ORIGIN = "iz AI pomoćnika (model, vrijeme)";
const INTACT = "zapis je cjelovit i neizmijenjen od primitka";
const PASTED = "zalijepljeno (izvor nije opažen)";
const GAP = "praznina u zapisu";

export const FORBIDDEN_TERMS: readonly ForbiddenTerm[] = [
  { entry: "sumnjivo", instead: NOTHING, lang: "hr", pattern: /sumnj/u },
  { entry: "rizik", instead: NOTHING, lang: "hr", pattern: /(?<!k)rizi[kc]/u },
  // The English forms of this entry are the entry "anomaly" below.
  {
    entry: "anomalija, anomaly",
    instead: NOTHING,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])anomal(?:ij|n|an(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "upozorenje o studentu",
    instead: NOTHING,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])upozoren\p{L}* o (?:\p{L}+ ){0,2}student/u,
  },
  {
    entry: "AI postotak",
    instead: AI_ORIGIN,
    lang: "hr",
    // A share by origin with or without the word (#179 A7): "udio AI-ja", "ljudski udio", "AI: 78 %", "78 % AI".
    pattern:
      /(?<![\p{L}\p{N}])(?:posto[tc]\p{L}* (?:ai(?![\p{L}\p{N}])|umjetn|ljudsk)|ai posto[tc]|(?:udio|udjel\p{L}*) (?:ai(?![\p{L}\p{N}])|umjetn|ljudsk|podrijetl|izvor)|(?:ai|ljudsk\p{L}*) (?:udio|udjel)|ai \d|\d+ (?:ai(?![\p{L}\p{N}])|ljudsk))/u,
  },
  // §5 delta 3: every form of the root, the adverb "vjerojatno" included (§5: "vjerojatnost (i vjerojatno)").
  // Ductus leaves the adverb out for its word list MODALS (src/domain/diff/diff.ts), which this repository does not have.
  {
    entry: "vjerojatnost",
    instead: AI_ORIGIN,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])(?:naj|ne)?vjerojat/u,
  },
  {
    entry: "autentičnost",
    instead: AI_ORIGIN,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])(?:(?:ne)?autentica?n|autenticitet)/u,
  },
  {
    entry: "napisao AI",
    instead: AI_ORIGIN,
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:napisa\p{L}* (?:(?:ga|je) ){0,2}(?:ai(?![\p{L}\p{N}])|umjetn)|(?:ai|umjetn\p{L}* inteligencij\p{L}*) (?:(?:ga|je) ){0,2}napisa)/u,
  },
  {
    entry: "verificirano autorstvo",
    instead: INTACT,
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:verificiran\p{L}* autorstv|autorstv\p{L}* (?:\p{L}+ ){0,2}verificiran)/u,
  },
  {
    entry: "dokaz autorstva",
    instead: INTACT,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])dokaz\p{L}* (?:o )?autorstv/u,
  },
  // Every form of the root (#179 A1). §5 delta 1: only the three allowed actions of §5 stay, in exactly those words
  // ("Kopiraj navod", "kopiranje navoda", "Kopirano u međuspremnik", D-59); Ductus also lets every imperative
  // "kopiraj(te|mo)" and every case of the two nouns through. Any prefix ("ukopiran", "fotokopirano") is flagged.
  {
    entry: "kopirano",
    instead: PASTED,
    lang: "hr",
    pattern:
      /(?:(?<=[\p{L}\p{N}])kopir|(?<![\p{L}\p{N}])kopir(?!aj navod(?![\p{L}\p{N}]))(?!anje navoda(?![\p{L}\p{N}]))(?!ano u meduspremnik(?![\p{L}\p{N}])))/u,
    readsPhrases: true,
  },
  // Every form of the root (#179 A3), "prepiši" in a sync conflict included; not "prepiska" or "prepisci" (correspondence).
  {
    entry: "prepisano",
    instead: PASTED,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])prepis(?!k|ci(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "nestali podaci",
    instead: GAP,
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:nesta\p{L}* poda[tc]|poda[tc]\p{L}* (?:\p{L}+ ){0,2}nesta(?:l\p{L}*|o|j\p{L}*|n(?:ak|e|u|em)?)(?![\p{L}\p{N}]))/u,
  },
  // §5 delta 4: B8 of #179 ("nedostajući / izgubljeni podaci") applies only to the record of the process in the teacher
  // view and the summary. The scan cannot tell that from a recovery message on the student's device, so here the row is
  // checked always (Ductus leaves it out, owner 23. 10. 2026.). A text that meets the condition needs a listed exception.
  {
    entry: "nedostajući podaci",
    instead: GAP,
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:(?:nedostaj|izgublj)\p{L}* (?:\p{L}+ )?poda[tc]|poda[tc]\p{L}* (?:\p{L}+ ){0,2}(?:nedostaj|izgub)\p{L}*)/u,
  },
  // The adjective and participle only (#179 A5): the imperative "Sakrij …" stays (owner decision 6).
  {
    entry: "skriveno",
    instead: GAP,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])(?:sakriv|prikriv|skriv)en/u,
  },
  // New rows of #179 table B. The adjectives "izvorni / originalni" and "nepravilan format" stay allowed.
  { entry: "plagijat", instead: NOTHING, lang: "hr", pattern: /(?<![\p{L}\p{N}])plagi[jr]/u },
  {
    entry: "izvornost",
    instead: INTACT,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])(?:izvornos[tc]|originalnos[tc])/u,
  },
  {
    entry: "integritet",
    instead: "cjelovitost zapisa",
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])integritet/u,
  },
  {
    entry: "neobično",
    instead: NOTHING,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])(?:neobic|neuobicajen)/u,
  },
  // §5 delta 4: "nepravilno" too, checked always; "nepravilan format" stays allowed.
  {
    entry: "nepravilnost",
    instead: NOTHING,
    lang: "hr",
    pattern: /(?<![\p{L}\p{N}])nepraviln(?:os[tc]|o(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "tuđi tekst",
    instead: PASTED,
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:tud\p{L}* (?:tekst(?:a|u|om|ovi|ova|ovima|e)?|rijec(?:i|ju|ima)?)(?![\p{L}\p{N}])|(?:nije|nisu) (?:vlastit|njegov|njezin|njen)\p{L}* (?:tekst(?:a|u|om|ovi|ova|ovima|e)?|rijec(?:i|ju|ima)?|odlom(?:ak|ka|ku|kom|ke|ci|aka|cima)|rad(?:a|u|om|e|ovi|ova|ovima)?)(?![\p{L}\p{N}])|(?:tekst(?:a|u|om|ovi|ova|ovima|e)?|rijec(?:i|ju|ima)?|odlom(?:ak|ka|ku|kom|ke|ci|aka|cima)|rad(?:a|u|om|e|ovi|ova|ovima)?)(?![\p{L}\p{N}]) (?:nije|nisu) (?:vlastit|njegov|njezin|njen)\p{L}*)/u,
  },
  {
    entry: "napisao čovjek",
    instead: "opaženo pisanje u uređivaču",
    lang: "hr",
    pattern:
      /(?<![\p{L}\p{N}])(?:ljudsk\p{L}* napisa|napisa\p{L}* (?:(?:ga|je) ){0,2}covjek|covjek\p{L}* (?:(?:ga|je) ){0,2}napisa)/u,
  },
  {
    entry: "spremljeno (bez pojašnjenja)",
    instead: "spremljeno na uređaju / spremljeno na poslužitelju / predano",
    lang: "hr",
    pattern: /(?<!\p{L})spremljen\p{L}*(?!\p{L})(?! na (?:uredaju|posluzitelju)(?![\p{L}\p{N}]))/u,
    contextual: { word: /(?<![\p{L}\p{N}])spremljen\p{L}*(?![\p{L}\p{N}])/u },
  },
  // The same entries in the English interface (D-90, point 3).
  {
    entry: "suspicious",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:suspic|suspect|doubt)/u,
  },
  {
    entry: "risk",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:low|high|zero|no)?risk/u,
  },
  {
    entry: "anomaly",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])anomal(?:y|ies|ous|istic)/u,
  },
  {
    entry: "warning about the student",
    instead: NOTHING,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:(?:warning|alert)s? (?:about|on|regarding|concerning) (?:the |a |this |these |that |those )?student|student\p{L}* (?:warning|alert))/u,
  },
  {
    entry: "AI percentage",
    instead: AI_ORIGIN,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:ai percent|percent\p{L}* (?:of )?(?:ai(?![\p{L}\p{N}])|artificial|human)|(?:ai|human) (?:share|percent|proportion)|humanness|\d+ (?:ai|human)(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "probability",
    instead: AI_ORIGIN,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:probab(?:il|l)|likelihood)/u,
  },
  // "authentic", "authentically", "authenticity" and "inauthentic", not "authenticate" or "authentication".
  {
    entry: "authenticity",
    instead: AI_ORIGIN,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:in|un)?authentic(?!at)/u,
  },
  {
    entry: "written by AI",
    instead: AI_ORIGIN,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:(?:written|generated) by (?:ai(?![\p{L}\p{N}])|artificial)|ai (?:written|generated|wrote)(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "verified authorship",
    instead: INTACT,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])verified authorship/u,
  },
  {
    entry: "proof of authorship",
    instead: INTACT,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])proofs? of authorship/u,
  },
  {
    entry: "copied",
    instead: PASTED,
    lang: "en",
    // §5 delta 2: every word that starts with a form of "copy" (copyright included), except "Copy citation" (D-59).
    // Ductus lets "Copy", "copies" and "Copied to clipboard" through. A prefixed form ("recopy", "photocopied") is flagged.
    pattern:
      /(?<=[\p{L}\p{N}])cop(?:y|ie)|(?<![\p{L}\p{N}])cop(?:y(?! citation(?![\p{L}\p{N}]))|ie)/u,
    readsPhrases: true,
  },
  // §5 delta 5: "vanished data" (row "nestali podaci"), which Ductus does not have.
  {
    entry: "vanished data",
    instead: GAP,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:vanished data|data (?:\p{L}+ ){0,2}vanished)/u,
  },
  // §5 delta 4: "lost data" with "missing data", checked always (the row of "nedostajući podaci").
  {
    entry: "missing data",
    instead: GAP,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:(?:missing|lost) (?:\p{L}+ )?data|data (?:\p{L}+ ){0,2}(?:missing|lost))(?![\p{L}\p{N}])/u,
  },
  { entry: "hidden", instead: GAP, lang: "en", pattern: /(?<![\p{L}\p{N}])(?:hidden|concealed)/u },
  { entry: "plagiarism", instead: NOTHING, lang: "en", pattern: /(?<![\p{L}\p{N}])plagiar/u },
  {
    entry: "originality",
    instead: INTACT,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:originality|unoriginal)/u,
  },
  {
    entry: "integrity",
    instead: "completeness of the record",
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])integrity/u,
  },
  {
    entry: "unusual",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:unusual|atypical)/u,
  },
  { entry: "irregularity", instead: NOTHING, lang: "en", pattern: /(?<![\p{L}\p{N}])irregularit/u },
  {
    entry: "someone else's text",
    instead: PASTED,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:someone else s (?:text|words)|not (?:their|his|her) own (?:text|words?|writing|paragraph|passage))(?![\p{L}\p{N}])/u,
  },
  {
    entry: "written by a human",
    instead: "observed writing in the editor",
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:human written|written by (?:a )?human)/u,
  },
  {
    entry: "saved (without saying where)",
    instead: "saved on this device / saved on the server / submitted",
    lang: "en",
    pattern:
      /(?<!\p{L})saved(?!\p{L})(?! (?:on|to) (?:the |this |your )?(?:device|server)(?![\p{L}\p{N}]))/u,
    contextual: { word: /(?<![\p{L}\p{N}])saved(?![\p{L}\p{N}])/u },
  },
  // §5 delta 5: the additional English list of D-276 (§5, "Dodatni engleski popis"), which Ductus has not added yet
  // (M11.5-P01a). Its rows with a condition ("misconduct", "flagged" about a work or a student) are checked always (delta 4).
  {
    entry: "risk score, trust score, attention score, suspicion score",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:risk|trust|attention|suspicion) scor/u,
  },
  {
    entry: "cheating, dishonest, misconduct",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])(?:cheat|dishonest|misconduct)/u,
  },
  {
    entry: "AI-detected, flagged as AI",
    instead: NOTHING,
    lang: "en",
    pattern:
      /(?<![\p{L}\p{N}])(?:ai detect|detected as ai(?![\p{L}\p{N}])|flagged as ai(?![\p{L}\p{N}]))/u,
  },
  {
    entry: "flagged, flagged for review",
    instead: NOTHING,
    lang: "en",
    pattern: /(?<![\p{L}\p{N}])flag(?:s|ged|ging)?(?![\p{L}\p{N}])/u,
  },
];

/** Format characters (soft hyphen, zero width, bidi controls, BOM) and Hangul fillers. */
const INVISIBLE = /[\p{Cf}\u115F\u1160\u3164\uFFA0]/gu;

/** Folds text for matching; NFKC also turns full width and mathematical letters into the letter. */
export function foldText(text: string): string {
  return foldLetters(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The letters and digits of `text` as the patterns expect them; everything between them is left as written. */
function foldLetters(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLocaleLowerCase("hr")
    .replaceAll("đ", "d")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

/**
 * Stands in folded text wherever a phrase ends. It is not a space, so the
 * spaces written in a pattern do not match it, and it is not a letter or a
 * digit, so a word still ends at it. It is U+FFFF, a code point that is no
 * character; the characters check of the locales scan (PR-b2) reports a text
 * that writes it.
 */
export const PHRASE_BREAK = "\uFFFF";

/**
 * White space that keeps two words in one phrase on one line: spaces of every
 * width and the tab. U+2028 (line separator) is on this side only because the
 * tests of the earlier QA round hold it as a space.
 */
const SPACES_ONLY = /^[\p{Zs}\t\p{Zl}]+$/u;

/**
 * Folds text like `foldText`, but keeps where a phrase ends: white space of one
 * line stays a space, any other run of non-letters becomes `PHRASE_BREAK`. So
 * "Spremljeno na uređaju." is acceptable and "Spremljeno. Na uređaju" is not.
 */
export function foldPhrases(text: string): string {
  return foldLetters(text)
    .replace(/[^\p{L}\p{N}]+/gu, (run) => (SPACES_ONLY.test(run) ? " " : PHRASE_BREAK))
    .replace(/^[ \uFFFF]+|[ \uFFFF]+$/g, "");
}

/** Dictionary entries that occur in `text`, in dictionary order; with `lang`, only the entries of that language. */
export function findForbiddenTerms(text: string, lang?: Language): ForbiddenTerm[] {
  const folded = foldText(text);
  const phrases = foldPhrases(text);
  return FORBIDDEN_TERMS.filter(
    (entry) =>
      (lang === undefined || entry.lang === lang) &&
      entry.pattern.test(entry.contextual || entry.readsPhrases ? phrases : folded),
  );
}
