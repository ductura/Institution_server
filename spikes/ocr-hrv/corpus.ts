// Invented Croatian documents for the OCR spike. Every person, course, place and date is made up.
// Each page is a list of lines; the ground truth is the lines joined by "\n".

export type CorpusPage = {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
};

export const INSTRUCTIONS: CorpusPage = {
  id: "upute",
  title: "Upute za seminarski rad",
  lines: [
    "Upute za seminarski rad: Kućno kompostiranje u gradu",
    "Kolegij: Izmišljeni seminar iz ekologije grada, 2026./2027.",
    "Nositeljica kolegija: doc. dr. sc. Šima Đurđević-Lovrić (izmišljena osoba)",
    "Rok za predaju prve verzije: 15. 12. 2026. do 23:59 sati.",
    "Rok za predaju konačne verzije: 12. siječnja 2027. do 12:00 sati.",
    "Savjetovanje s mentoricom održat će se 3. 12. 2026. u dvorani Ž-204.",
    "Rad ima od 4000 do 6000 riječi, bez naslovne stranice i popisa literature.",
    "Čišćenje podataka, žuta i zelena tablica te đubrivo opisuju se u drugom poglavlju.",
    "Navodi se najmanje pet izvora; citira se po pravilima fakulteta, npr. (Čačić, 2025: 14).",
    "Ocjenjuje se: argumentacija (40 %), izvori (30 %), jezik (20 %), oblik (10 %).",
    "Pitanja šaljite do 1. 12. 2026. na adresu mentor@primjer.invalid.",
    "Predaja izvan roka moguća je samo uz odobrenje nositeljice, najkasnije do 19. 1. 2027.",
  ],
};

export const BIBLIOGRAPHY: CorpusPage = {
  id: "literatura",
  title: "Popis literature",
  lines: [
    "Popis literature (izmišljeni izvori)",
    "Čačić, Željko. 2025. Kompostiranje u malom: priručnik za kućanstva. Lipovac: Zelena knjiga.",
    "Đurđević, Ana i Šoštarić, Luka. 2024. „Otpad u gradskim zajednicama”. Časopis za okoliš, 12(3), 45–61.",
    "Horvat, Marta. 2023. Biološki otpad: mjerenje i smanjenje. Zagreb: Izmišljena naklada.",
    "Jurić, Đuro. 2026. Prikupljanje kuhinjskog otpada u Lipovcu. Dostupno 8. 9. 2026.",
    "Knežević, Šime. 2022. Žuti, zeleni i smeđi otpad. Osijek: Primjer d.o.o.",
    "Ljubić, Čedomir. 2021. Đubrivo iz vlastitog dvorišta. Časopis za okoliš, 9(1), 3–19.",
    "Pavlović, Žana. 2025. Gradski vrtovi i kompost, 2. izd. Varaždin: Zelena knjiga.",
    "Šarić, Ćiro. 2020. Sakupljanje i obrada otpada: pregled, 17. 5. 2020.",
    "Vuković, Đurđica. 2024. Održivost u kućanstvu. Lipovac: Izmišljena naklada, str. 112–130.",
  ],
};

export const PAGES: readonly CorpusPage[] = [INSTRUCTIONS, BIBLIOGRAPHY];

export const DIACRITICS = "čćđšžČĆĐŠŽ";

// Dates as they are written in Croatian documents: "15. 12. 2026.", "12. siječnja 2027.", "3.5.2025."
const DATE_PATTERN =
  /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}\.?|\b\d{1,2}\.\s(?:siječnja|veljače|ožujka|travnja|svibnja|lipnja|srpnja|kolovoza|rujna|listopada|studenoga|prosinca)\s\d{4}/gu;

export function extractDates(text: string): string[] {
  return (text.match(DATE_PATTERN) ?? []).map((date) => date.replace(/\s+/gu, " ").trim());
}

export function groundTruth(page: CorpusPage): string {
  return page.lines.join("\n");
}
