// DAN-1566: an invented Croatian seminar paper. Every name, title and
// sentence is made up here from fixed word lists; nothing is taken from a
// real paper or a real person. The same seed gives the same paper.

/** A small seeded generator (mulberry32); never `Math.random`. */
export type Random = {
  /** A whole number in `0..below-1`. */
  int(below: number): number;
  pick<T>(items: readonly T[]): T;
  /** A lowercase UUID v4 drawn from the seed. */
  uuid(): string;
};

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  const hex = (length: number): string =>
    Array.from({ length }, () => int(16).toString(16)).join("");
  return {
    int,
    pick: (items) => items[int(items.length)]!,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[int(4)]!}${hex(3)}-${hex(12)}`,
  };
}

export type SyntheticSection = { heading: string; paragraphs: string[] };

export type SyntheticPaper = {
  author: { name: string; email: string };
  title: string;
  sections: SyntheticSection[];
  /** One sentence the writer pastes instead of typing. */
  pastedSentence: string;
};

// Names no real person is expected to carry: the surnames are made-up words.
const GIVEN = ["Izmišljena Ana", "Izmišljeni Ivo", "Izmišljena Mara", "Izmišljeni Luka"];
const FAMILY = ["Probnić", "Uzorković", "Testić", "Primjerović"];
const TOPICS = [
  "lokalna samouprava u izmišljenoj općini Donji Uzorak",
  "izborni sustav izmišljene države Probnije",
  "javne politike u izmišljenom gradu Primjergradu",
  "medijska pismenost u izmišljenoj županiji Testnoj",
];
const HEADINGS = ["Uvod", "Teorijski okvir", "Metoda", "Rasprava", "Zaključak"];
const SUBJECTS = [
  "Ovaj rad",
  "Izmišljeni primjer",
  "Analiza u ovom poglavlju",
  "Pregled izmišljene građe",
  "Polazna pretpostavka",
];
const VERBS = ["opisuje", "uspoređuje", "razmatra", "pokazuje", "propituje"];
const OBJECTS = [
  "odnos između pravila i prakse",
  "način na koji se odluke donose",
  "razlike među izmišljenim slučajevima",
  "ulogu građana u odlučivanju",
  "granice odabranog pristupa",
];
const TAILS = [
  "na primjeru koji je u cijelosti izmišljen",
  "bez pozivanja na stvarne osobe",
  "u okviru zadanom za ovaj probni tekst",
  "kako bi se provjerio rad alata",
  "u tri uzastopna koraka",
];

const sentence = (random: Random): string =>
  `${random.pick(SUBJECTS)} ${random.pick(VERBS)} ${random.pick(OBJECTS)} ${random.pick(TAILS)}.`;

/** An invented paper of `sections` sections (1 to 5), two or three paragraphs each. */
export function generateSyntheticPaper(random: Random, sections = 3): SyntheticPaper {
  if (!Number.isInteger(sections) || sections < 1 || sections > HEADINGS.length) {
    throw new RangeError(`sections must be 1 to ${HEADINGS.length}: ${sections}`);
  }
  const family = random.pick(FAMILY);
  const paragraph = (): string =>
    Array.from({ length: 2 + random.int(3) }, () => sentence(random)).join(" ");
  return {
    author: {
      name: `${random.pick(GIVEN)} ${family}`,
      email: `${family.toLowerCase().replace("ć", "c")}@student.example.invalid`,
    },
    title: `Probni seminarski rad: ${random.pick(TOPICS)}`,
    sections: HEADINGS.slice(0, sections).map((heading) => ({
      heading,
      paragraphs: Array.from({ length: 2 + random.int(2) }, paragraph),
    })),
    pastedSentence: `„${sentence(random)}” (izmišljeni navod, bez stvarnog izvora).`,
  };
}
