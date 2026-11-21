// Invented academic text for the PDF/A spike. Every name, place, figure and
// claim is made up; nothing is taken from a real student work (CLAUDE.md).

export type Section = {
  heading: string;
  subsections: { heading: string; paragraphs: string[] }[];
};

export type Corpus = { title: string; author: string; sections: Section[]; wordCount: number };

const SUBJECTS = [
  "Kućno kompostiranje u izmišljenom gradu Lipovcu",
  "Gradska zajednica „Zelena četvrt”",
  "Anketa među stanarima Ulice Šumskih jaglaca",
  "Općinski odjel za čistoću",
  "Izmišljena udruga „Đurđica”",
  "Pilot-skupina od četrdeset kućanstava",
  "Školski vrt na Trgu Čađavih dimnjaka",
  "Model raspodjele kanti za biootpad",
];
const VERBS = [
  "pokazuje",
  "upućuje na to da",
  "potvrđuje pretpostavku da",
  "dovodi u pitanje tvrdnju da",
  "djelomično objašnjava zašto",
  "otvara pitanje zašto",
];
const CLAIMS = [
  "se udio odvojenog otpada povećava kad je kanta bliže ulazu",
  "stanari češće kompostiraju ljeti nego zimi",
  "jasne upute smanjuju broj pogrešno razvrstanih vrećica",
  "susjedska pomoć ima veći učinak od novčane nagrade",
  "trošak odvoza pada nakon prve godine primjene",
  "mlađa kućanstva brže prihvaćaju nove navike",
  "šćućureni vrtovi u dvorištima traže drukčiji raspored",
  "čađa iz starih peći ne smije završiti u kompostu",
];
const LINKS = [
  "S druge strane,",
  "Osim toga,",
  "Unatoč tome,",
  "Zbog toga",
  "Prema izmišljenim podacima iz 2026. godine,",
  "U usporedbi s prethodnim razdobljem,",
];

// Mulberry32: small deterministic PRNG, so the same seed gives the same text.
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error("empty word list");
  return item;
}

function sentence(random: () => number): string {
  const link = random() < 0.4 ? `${pick(LINKS, random)} ` : "";
  const body = `${pick(SUBJECTS, random)} ${pick(VERBS, random)} ${pick(CLAIMS, random)}.`;
  return link === "" ? body : link + body.charAt(0).toLowerCase() + body.slice(1);
}

/**
 * Builds a document of exactly `targetWords` words in its paragraphs (headings
 * and the title page are counted too), grouped into chapters of four
 * subsections each.
 */
export function buildCorpus(targetWords: number, seed = 1805): Corpus {
  if (!Number.isInteger(targetWords) || targetWords < 200) {
    throw new RangeError("targetWords must be an integer of at least 200");
  }
  const random = prng(seed);
  const title = "Kućno kompostiranje u izmišljenom gradu Lipovcu: seminarski rad";
  const author = "Izmišljena Studentica (demo-student)";
  let words = countWords(title) + countWords(author);
  const sections: Section[] = [];

  for (let chapter = 1; words < targetWords; chapter += 1) {
    const heading = `${chapter}. Poglavlje o izmišljenim nalazima, dio ${chapter}`;
    words += countWords(heading);
    const section: Section = { heading, subsections: [] };
    sections.push(section);
    for (let sub = 1; sub <= 4 && words < targetWords; sub += 1) {
      const subHeading = `${chapter}.${sub}. Odjeljak ${sub}`;
      words += countWords(subHeading);
      const paragraphs: string[] = [];
      section.subsections.push({ heading: subHeading, paragraphs });
      for (let p = 0; p < 6 && words < targetWords; p += 1) {
        const parts: string[] = [];
        let paragraphWords = 0;
        const length = 90 + Math.floor(random() * 60);
        while (paragraphWords < length && words + paragraphWords < targetWords) {
          const next = sentence(random);
          const remaining = targetWords - words - paragraphWords;
          const nextWords = countWords(next);
          const text = nextWords <= remaining ? next : trimTo(next, remaining);
          parts.push(text);
          paragraphWords += countWords(text);
        }
        paragraphs.push(parts.join(" "));
        words += paragraphWords;
      }
    }
  }
  return { title, author, sections, wordCount: words };
}

function trimTo(text: string, words: number): string {
  const kept = text.split(" ").slice(0, words).join(" ").replace(/[,.]$/u, "");
  return `${kept}.`;
}

/** All words the reader sees, counted the same way as buildCorpus. */
export function corpusWordCount(corpus: Corpus): number {
  let words = countWords(corpus.title) + countWords(corpus.author);
  for (const section of corpus.sections) {
    words += countWords(section.heading);
    for (const sub of section.subsections) {
      words += countWords(sub.heading);
      for (const paragraph of sub.paragraphs) words += countWords(paragraph);
    }
  }
  return words;
}
